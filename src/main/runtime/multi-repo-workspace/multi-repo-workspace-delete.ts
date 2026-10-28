import { access, rmdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  MultiRepoWorkspaceError,
  type MultiRepoDeleteInspection,
  type MultiRepoDeleteMemberInspection,
  type MultiRepoDeleteMemberOutcome,
  type MultiRepoDeleteResult,
  type MultiRepoMember
} from '../../../shared/multi-repo-workspace'
import { bucketMultiRepoMemberCount } from '../../../shared/telemetry-multi-repo-workspace-event-schemas'
import { splitWorktreeId } from '../../../shared/worktree/id'
import { ensurePathWithinWorkspace } from '../../ipc/worktree-logic'
import { getStatus } from '../../git/status'
import { gitExecFileAsync } from '../../git/runner'
import { track } from '../../telemetry/client'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'
import { requireMultiRepoWorkspace, writeMultiRepoRecord } from './multi-repo-workspace-record'

const DELETE_CONCURRENCY = 3

export type MultiRepoDeleteRequest = {
  folderWorkspaceId: string
  forceMemberIds?: string[]
  allowFailedArchiveHookMemberIds?: string[]
  runHooks?: boolean
}

export async function inspectMultiRepoDelete(
  port: MultiRepoWorkspacePort,
  folderWorkspaceId: string
): Promise<MultiRepoDeleteInspection> {
  const workspace = requireMultiRepoWorkspace(port.requireStore(), folderWorkspaceId)
  const members = await mapWithConcurrency(workspace.multiRepo.members, (member) =>
    inspectMember(port, member)
  )
  return {
    folderWorkspaceId,
    members,
    rootPath: workspace.folderPath,
    rootOwnedByOrca: workspace.multiRepo.rootOwnedByOrca
  }
}

async function inspectMember(
  port: MultiRepoWorkspacePort,
  member: MultiRepoMember
): Promise<MultiRepoDeleteMemberInspection> {
  const base = {
    memberId: member.memberId,
    repoId: member.repoId,
    state: member.state,
    worktreeId: member.worktreeId ?? null
  }
  const worktreePath = member.worktreeId ? splitWorktreeId(member.worktreeId)?.worktreePath : null
  if (!worktreePath || !(await pathExists(worktreePath))) {
    return {
      ...base,
      worktreeExists: false,
      dirtyCount: 0,
      unpublishedCommitCount: 0,
      willKeepBranch: false
    }
  }
  const store = port.requireStore()
  const repo = store.getRepos().find((entry) => entry.id === member.repoId)
  const [dirtyCount, unpublishedCommitCount, branchMerged] = await Promise.all([
    readDirtyCount(worktreePath),
    readUnpublishedCommitCount(worktreePath, repo?.path, member.baseRef),
    repo ? isBranchMerged(repo.path, member.branchName) : Promise.resolve(null)
  ])
  const preserved = store.getWorktreeMeta(member.worktreeId ?? '')?.preserveBranchOnDelete === true
  return {
    ...base,
    worktreeExists: true,
    dirtyCount,
    unpublishedCommitCount,
    willKeepBranch: preserved ? true : branchMerged === null ? null : !branchMerged
  }
}

export async function deleteMultiRepoWorkspace(
  port: MultiRepoWorkspacePort,
  request: MultiRepoDeleteRequest,
  isMemberActive: (memberId: string) => boolean
): Promise<MultiRepoDeleteResult> {
  const store = port.requireStore()
  const workspace = requireMultiRepoWorkspace(store, request.folderWorkspaceId)
  const memberIds = new Set(workspace.multiRepo.members.map((member) => member.memberId))
  const force = new Set(request.forceMemberIds ?? [])
  const waiveHook = new Set(request.allowFailedArchiveHookMemberIds ?? [])
  for (const id of [...force, ...waiveHook]) {
    if (!memberIds.has(id)) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_delete_force_not_named',
        'Force was requested for a project that is not part of this workspace.',
        { memberId: id }
      )
    }
  }
  if (workspace.multiRepo.members.some((member) => isMemberActive(member.memberId))) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_create_in_progress',
      'Wait for the workspace to finish creating before deleting it.'
    )
  }
  const outcomes = await mapWithConcurrency(workspace.multiRepo.members, (member) =>
    removeMember(port, member, {
      force: force.has(member.memberId),
      allowFailedArchiveHook: waiveHook.has(member.memberId),
      runHooks: request.runHooks !== false
    })
  )
  const droppedIds = new Set(
    outcomes.filter((outcome) => outcome.status === 'dropped').map((outcome) => outcome.memberId)
  )
  if (droppedIds.size > 0) {
    writeMultiRepoRecord(store, request.folderWorkspaceId, (current) => ({
      ...current,
      members: current.members.filter((member) => !droppedIds.has(member.memberId))
    }))
  }
  port.notifyChanged()
  const remaining = requireMultiRepoWorkspace(store, request.folderWorkspaceId).multiRepo.members
  const finished = remaining.length === 0
  const rootKept = finished ? await removeWorkspaceRecordAndRoot(port, workspace) : undefined
  track('multi_repo_workspace_removed', {
    member_count_bucket: bucketMultiRepoMemberCount(workspace.multiRepo.members.length),
    outcome: finished ? 'all' : 'partial',
    kept_dir: rootKept !== undefined
  })
  return {
    folderWorkspaceId: request.folderWorkspaceId,
    members: outcomes,
    workspaceRemoved: finished,
    ...(rootKept ? { rootKept } : {}),
    remainingMemberCount: remaining.length
  }
}

async function removeMember(
  port: MultiRepoWorkspacePort,
  member: MultiRepoMember,
  flags: { force: boolean; allowFailedArchiveHook: boolean; runHooks: boolean }
): Promise<MultiRepoDeleteMemberOutcome> {
  if (!member.worktreeId) {
    return { memberId: member.memberId, status: 'dropped' }
  }
  try {
    const result = await port.removeWorktree(member.worktreeId, flags)
    return {
      memberId: member.memberId,
      status: 'removed',
      ...(result.preservedBranch ? { preservedBranch: result.preservedBranch.branchName } : {})
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'selector_not_found') {
      return { memberId: member.memberId, status: 'dropped' }
    }
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'runtime_error'
    return {
      memberId: member.memberId,
      status: 'failed',
      code,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** The parent goes last, and the root is only ever removed empty (never recursive). */
async function removeWorkspaceRecordAndRoot(
  port: MultiRepoWorkspacePort,
  workspace: FolderWorkspace & { multiRepo: { rootOwnedByOrca: boolean } }
): Promise<MultiRepoDeleteResult['rootKept']> {
  await port.deleteFolderWorkspace(workspace.id)
  if (
    !workspace.multiRepo.rootOwnedByOrca ||
    !ownerAnchors(port, workspace).some((anchor) =>
      isStrictlyInsideWorkspaceDir(workspace.folderPath, anchor)
    )
  ) {
    return { path: workspace.folderPath, reason: 'not_owned' }
  }
  try {
    await rmdir(workspace.folderPath)
    return undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    const notEmpty =
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
    return { path: workspace.folderPath, reason: notEmpty ? 'not_empty' : 'remove_failed' }
  }
}

/** The group parentPath records the workspaceDir at creation time, which may differ from the current setting. */
function ownerAnchors(port: MultiRepoWorkspacePort, workspace: FolderWorkspace): string[] {
  const store = port.requireStore()
  const groupParent = store
    .getProjectGroups?.()
    .find((group) => group.id === workspace.projectGroupId)?.parentPath
  return [store.getSettings().workspaceDir, ...(groupParent ? [groupParent] : [])]
}

/** Defense in depth: never rmdir the workspace directory itself or anything outside it. */
function isStrictlyInsideWorkspaceDir(rootPath: string, workspaceDir: string): boolean {
  try {
    return ensurePathWithinWorkspace(rootPath, workspaceDir) !== resolve(workspaceDir)
  } catch {
    return false
  }
}

async function readDirtyCount(worktreePath: string): Promise<number | null> {
  try {
    return (await getStatus(worktreePath, { includeLineStats: false })).entries.length
  } catch {
    return null
  }
}

/** Commits the member added itself: not on any remote and not already in the base it started from. */
export async function readUnpublishedCommitCount(
  worktreePath: string,
  repoPath: string | undefined,
  baseRef: string | undefined
): Promise<number | null> {
  try {
    const base = repoPath ? await resolveBaseCommit(repoPath, baseRef) : null
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...(base ? [base] : [])],
      { cwd: worktreePath }
    )
    const count = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(count) ? count : null
  } catch {
    return null
  }
}

async function resolveBaseCommit(
  repoPath: string,
  baseRef: string | undefined
): Promise<string | null> {
  for (const ref of [baseRef, 'HEAD']) {
    if (!ref) {
      continue
    }
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        {
          cwd: repoPath
        }
      )
      return stdout.trim() || null
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/** Mirrors `git branch -d`: merged into the main checkout's HEAD. Squash merges read as unmerged here. */
async function isBranchMerged(repoPath: string, branch: string): Promise<boolean | null> {
  try {
    await gitExecFileAsync(['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'], {
      cwd: repoPath
    })
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 1 ? false : null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, items.length) }, worker))
  return results
}
