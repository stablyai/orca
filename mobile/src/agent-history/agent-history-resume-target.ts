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

/** The phone sees no project runtime settings: a WSL terminal on a Windows host proves WSL, not which distro. */
function mobileResumeTargetWslDistro(
  worktree: Worktree | undefined,
  hostPlatform: NodeJS.Platform | null
): string | null | undefined {
  if (!worktree) {
    return undefined
  }
  const uncDistro = parseWslUncPath(worktree.path)?.distro
  if (uncDistro) {
    return uncDistro
  }
  return hostPlatform === 'win32' && worktree.terminalPlatform === 'linux' ? undefined : null
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
    const targetStatus = getAiVaultResumeWorkspaceTargetStatus(catalog, candidateWorktreeId)
    blockedStatus ??= targetStatus
    // Why: the host refuses phone terminals in a workspace another runtime owns.
    if (targetStatus !== 'local' && targetStatus !== 'ssh') {
      continue
    }
    const worktree = catalog.findWorktree(candidateWorktreeId)
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
      workspacePath: worktree?.path ?? null,
      terminalPlatform: worktree?.terminalPlatform ?? null
    }
  }

  return {
    status: 'blocked',
    message: mobileAiVaultResumeTargetBlockMessage(
      blockedStatus ?? getAiVaultResumeWorkspaceTargetStatus(catalog, args.activeWorktreeId)
    )
  }
}
