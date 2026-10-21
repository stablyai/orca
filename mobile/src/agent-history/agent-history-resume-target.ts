import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { canResumeAiVaultSessionOnSshHost } from '../../../src/shared/ai-vault-ssh-resume-target'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  getMobileAiVaultResumeWorktreeExecutionHostId,
  getMobileAiVaultResumeWorktreeTargetStatus,
  type MobileAiVaultResumeFolderWorkspace,
  type MobileAiVaultResumeProjectGroup,
  type MobileAiVaultResumeRepo,
  type MobileAiVaultResumeTargetStatus
} from './agent-history-resume-workspace-host'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree
} from './agent-history-session-worktree'

export type {
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup,
  MobileAiVaultResumeRepo,
  MobileAiVaultResumeTargetStatus
}

export type MobileAiVaultSessionResumeTarget =
  | {
      status: 'ready'
      worktreeId: string
      targetStatus: 'local' | 'ssh'
      workspacePath: string | null
      terminalPlatform: NodeJS.Platform | null
    }
  | { status: 'blocked'; message: string }

function canResumeMobileAiVaultSessionOnTarget(args: {
  session: AiVaultSession
  targetStatus: MobileAiVaultResumeTargetStatus
  targetExecutionHostId: ExecutionHostId | null
}): args is typeof args & { targetStatus: 'local' | 'ssh' } {
  if (args.targetStatus === 'local') {
    return true
  }
  // Why: same host rule as desktop: an SSH workspace resumes only transcripts that host can read.
  return (
    args.targetStatus === 'ssh' &&
    canResumeAiVaultSessionOnSshHost({
      sessionFilePath: args.session.filePath,
      sessionExecutionHostId: args.session.executionHostId,
      targetExecutionHostId: args.targetExecutionHostId
    })
  )
}

function mobileAiVaultResumeTargetBlockMessage(status: MobileAiVaultResumeTargetStatus): string {
  if (status === 'runtime') {
    return 'Resume from history is not available in runtime-hosted workspaces.'
  }
  if (status === 'ssh') {
    return 'This session belongs to a different host. Open a workspace on the same host to resume it.'
  }
  return 'Open a local workspace before resuming a session.'
}

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
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

  for (const candidateWorktreeId of candidateWorktreeIds) {
    const targetStatus = getMobileAiVaultResumeWorktreeTargetStatus({
      worktreeId: candidateWorktreeId,
      worktrees: args.worktrees,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces,
      projectGroups: args.projectGroups
    })
    const candidate = {
      session: args.session,
      targetStatus,
      targetExecutionHostId:
        targetStatus === 'ssh'
          ? getMobileAiVaultResumeWorktreeExecutionHostId({
              worktreeId: candidateWorktreeId,
              worktrees: args.worktrees,
              repos: args.repos,
              folderWorkspaces: args.folderWorkspaces ?? [],
              projectGroups: args.projectGroups ?? []
            })
          : null
    }
    if (!canResumeMobileAiVaultSessionOnTarget(candidate)) {
      continue
    }
    return {
      status: 'ready',
      worktreeId: candidateWorktreeId,
      targetStatus: candidate.targetStatus,
      workspacePath:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)?.path ??
        null,
      terminalPlatform:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)
          ?.terminalPlatform ?? null
    }
  }

  const blockedStatus = getMobileAiVaultResumeWorktreeTargetStatus({
    worktreeId: candidateWorktreeIds[0] ?? args.activeWorktreeId,
    worktrees: args.worktrees,
    repos: args.repos,
    folderWorkspaces: args.folderWorkspaces,
    projectGroups: args.projectGroups
  })
  return { status: 'blocked', message: mobileAiVaultResumeTargetBlockMessage(blockedStatus) }
}
