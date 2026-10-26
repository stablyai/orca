import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus,
  type AiVaultResumeTargetStatus
} from '../../../src/shared/ai-vault-resume-target'
import type {
  FolderHostCatalog,
  FolderHostRepo
} from '../../../src/shared/folder-workspace-execution-host'
import { parseWslUncPath } from '../../../src/shared/wsl-paths'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { getFolderWorkspaceWorktreeHostId } from '../../../src/shared/folder-workspace-worktree'
import { parseWorkspaceKey } from '../../../src/shared/workspace-scope'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  canJumpToAiVaultSessionWorktree,
  resolveAiVaultSessionWorktreeInfo,
  type AiVaultSessionOwnerWorkspace
} from '../../../src/shared/ai-vault-session-worktree'

/** The host catalog a resume target is resolved against: the same lists desktop reads from its store. */
export type MobileAiVaultResumeCatalog = FolderHostCatalog<FolderHostRepo & { id: string }>

export type MobileAiVaultSessionResumeTarget =
  | {
      status: 'ready'
      worktreeId: string
      targetStatus: 'local' | 'ssh'
      workspacePath: string | null
      terminalPlatform: NodeJS.Platform | null
    }
  | { status: 'blocked'; message: string }

function mobileAiVaultResumeTargetBlockMessage(status: AiVaultResumeTargetStatus): string {
  if (status === 'runtime') {
    return 'Resume from history is not available in runtime-hosted workspaces.'
  }
  if (status === 'ssh' || status === 'local') {
    return 'This session belongs to a different host. Open a workspace on the same host to resume it.'
  }
  return 'Open a workspace before resuming a session.'
}

/** Desktop's namespace rule from what the phone sees: the host's terminal platform already reflects the project runtime. */
function mobileResumeTargetWslDistro(
  worktree: Worktree,
  hostPlatform: NodeJS.Platform | null
): string | null | undefined {
  if (hostPlatform !== 'win32') {
    return hostPlatform ? null : undefined
  }
  if (worktree.terminalPlatform === 'win32') {
    return null
  }
  return parseWslUncPath(worktree.path)?.distro
}

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  catalog: MobileAiVaultResumeCatalog
  hostPlatform: NodeJS.Platform | null
}): MobileAiVaultSessionResumeTarget {
  const sessionWorktree = resolveAiVaultSessionWorktreeInfo({
    session: args.session,
    repos: args.catalog.repos,
    worktrees: args.worktrees.map((worktree) =>
      toAiVaultSessionOwnerWorkspace(worktree, args.catalog)
    ),
    activeWorktreeId: args.activeWorktreeId
  })
  const sessionWorktreeId = canJumpToAiVaultSessionWorktree(sessionWorktree)
    ? sessionWorktree?.worktreeId
    : null
  const candidateWorktreeIds = [
    sessionWorktreeId,
    args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
      ? args.activeWorktreeId
      : null
  ].filter((candidate): candidate is string => Boolean(candidate))
  const catalog = {
    ...args.catalog,
    findWorktree: (worktreeId: string) =>
      args.worktrees.find((worktree) => worktree.worktreeId === worktreeId)
  }

  let blockedStatus: AiVaultResumeTargetStatus | null = null
  for (const candidateWorktreeId of candidateWorktreeIds) {
    const worktree = catalog.findWorktree(candidateWorktreeId)
    // Why: host resolution falls back to the repo, which outlives a deleted workspace.
    const targetStatus = worktree
      ? getAiVaultResumeWorkspaceTargetStatus(catalog, candidateWorktreeId)
      : 'unknown'
    blockedStatus ??= targetStatus
    // Why: the host refuses phone terminals in a workspace another runtime owns.
    if (!worktree || (targetStatus !== 'local' && targetStatus !== 'ssh')) {
      continue
    }
    if (
      !canResumeAiVaultSessionOnTarget({
        sessionFilePath: args.session.filePath,
        sessionExecutionHostId: args.session.executionHostId,
        targetStatus,
        targetExecutionHostId: getAiVaultResumeWorkspaceExecutionHostId(
          catalog,
          candidateWorktreeId
        ),
        targetWslDistro: mobileResumeTargetWslDistro(worktree, args.hostPlatform)
      })
    ) {
      continue
    }
    return {
      status: 'ready',
      worktreeId: candidateWorktreeId,
      targetStatus,
      workspacePath: worktree.path,
      terminalPlatform: worktree.terminalPlatform ?? null
    }
  }

  return {
    status: 'blocked',
    message: mobileAiVaultResumeTargetBlockMessage(blockedStatus ?? 'unknown')
  }
}

/** Folder rows carry no hostId on worktree.ps; desktop's folder row takes it from the folder record. */
function toAiVaultSessionOwnerWorkspace(
  worktree: Worktree,
  catalog: MobileAiVaultResumeCatalog
): AiVaultSessionOwnerWorkspace {
  const workspaceKey = parseWorkspaceKey(worktree.worktreeId)
  const folder =
    workspaceKey?.type === 'folder'
      ? catalog.folderWorkspaces.find((entry) => entry.id === workspaceKey.folderWorkspaceId)
      : undefined
  return {
    id: worktree.worktreeId,
    path: worktree.path,
    repoId: worktree.repoId,
    displayName: worktree.displayName,
    hostId:
      worktree.hostId ??
      (folder
        ? getFolderWorkspaceWorktreeHostId({
            executionHostId: normalizeExecutionHostId(folder.executionHostId),
            connectionId: folder.connectionId
          })
        : undefined),
    isArchived: worktree.isArchived,
    priorWorktreeIds: worktree.priorWorktreeIds
  }
}
