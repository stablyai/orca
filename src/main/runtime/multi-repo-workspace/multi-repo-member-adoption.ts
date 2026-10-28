import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { MultiRepoMember, MultiRepoWorkspace } from '../../../shared/multi-repo-workspace'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { worktreeRowTarget } from '../../persistence/host-qualified-worktree-meta'
import { recordCreatedWorktreeLineage } from '../runtime-worktree-lineage-recording'
import { PlacedWorktreePathOccupiedError } from './placed-worktree-path-occupied-error'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'

/** Idempotent retry: adopt a worktree already registered at the expected path, never delete anything. */
export async function tryAdoptMultiRepoMember(
  port: MultiRepoWorkspacePort,
  workspace: FolderWorkspace & { multiRepo: MultiRepoWorkspace },
  member: MultiRepoMember
): Promise<{ worktreeId: string; instanceId?: string; branch: string } | null> {
  const expected = normalizeRuntimePathForComparison(join(workspace.folderPath, member.dirName))
  const detected = await port.listDetectedWorktrees(member.repoId).catch(() => null)
  const match = detected?.worktrees.find(
    (entry) => normalizeRuntimePathForComparison(entry.path) === expected
  )
  if (!match) {
    if (await pathExists(join(workspace.folderPath, member.dirName))) {
      throw new PlacedWorktreePathOccupiedError(join(workspace.folderPath, member.dirName))
    }
    return null
  }
  const branch = match.branch.replace(/^refs\/heads\//, '')
  if (match.repoId !== member.repoId || (member.branchExplicit && branch !== member.branchName)) {
    throw new PlacedWorktreePathOccupiedError(match.path)
  }
  const store = port.requireStore()
  const target = worktreeRowTarget(store, { id: match.id, hostId: match.hostId })
  const meta = target ? store.setWorktreeMeta(target, {}) : undefined
  const instanceId = meta?.instanceId ?? match.instanceId
  recordMultiRepoMemberLineage(port, workspace, match.id, instanceId)
  return { worktreeId: match.id, instanceId, branch }
}

export function recordMultiRepoMemberLineage(
  port: MultiRepoWorkspacePort,
  workspace: FolderWorkspace,
  worktreeId: string,
  instanceId: string | undefined
): void {
  recordCreatedWorktreeLineage(
    port.requireStore(),
    { id: worktreeId, instanceId, hostId: undefined },
    {
      kind: 'lineage',
      parent: {
        type: 'folder',
        workspaceKey: folderWorkspaceKey(workspace.id),
        folderWorkspace: workspace,
        instanceId: null
      },
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
    }
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
