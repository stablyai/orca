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
import type { Worktree } from '../worktree/workspace-list-types'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree
} from './agent-history-session-worktree'

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

/** The host's terminal platform already reflects the project runtime: native Windows or no WSL proves null; a WSL runtime proves no distro. */
function mobileResumeTargetWslDistro(
  worktree: Worktree,
  hostPlatform: NodeJS.Platform | null
): string | null | undefined {
  if (hostPlatform && hostPlatform !== 'win32') {
    return null
  }
  return hostPlatform === 'win32' && worktree.terminalPlatform === 'win32' ? null : undefined
}

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  catalog: MobileAiVaultResumeCatalog
  hostPlatform: NodeJS.Platform | null
}): MobileAiVaultSessionResumeTarget {
  const sessionWorktree = resolveMobileAgentHistorySessionWorktree({
    session: args.session,
    worktrees: args.worktrees,
    activeWorktreeId: args.activeWorktreeId
  })
  const sessionWorktreeId = canResumeInMobileSessionWorktree(sessionWorktree)
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
