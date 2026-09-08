import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  buildMobileAiVaultResumeLaunch,
  resolveMobileAiVaultResumePlatform,
  type MobileAiVaultResumeSettings
} from '../../../../shared/mobile-ai-vault-resume-launch-plan'
import type {
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup,
  MobileAiVaultResumeRepo
} from '../../../../shared/mobile-ai-vault-resume-host-status'
import { resolveMobileAiVaultSessionResumeTarget } from '../../../../shared/mobile-ai-vault-resume-target'
import type { MobileAiVaultWorktree } from '../../../../shared/mobile-ai-vault-session-worktree'
import type { RpcContext } from '../core'
import {
  mobileWebAgentHistoryRpc,
  type MobileWebAgentHistoryWorktree
} from './mobile-web-agent-history-rpc'

export type MobileWebAgentHistoryResumeResult =
  | {
      status: 'queued'
      targetIsCurrentWorkspace: boolean
      targetWorktreeId: string
      targetWorkspaceName: string
    }
  | { status: 'blocked'; message: string }

export async function resumeMobileWebAgentHistorySession(args: {
  session: AiVaultSession
  activeWorktreeId: string
  context: RpcContext
}): Promise<MobileWebAgentHistoryResumeResult> {
  if (!args.session.sessionId.trim()) {
    return { status: 'blocked', message: 'This session is missing a resume id.' }
  }
  const rpc = mobileWebAgentHistoryRpc(args.context)
  // Only the worktree listing touches disk; the rest are in-memory registry reads.
  const worktrees = await rpc.worktrees()
  const repos = rpc.repos()
  const folderWorkspaces = rpc.folderWorkspaces()
  const projectGroups = rpc.projectGroups()
  const settings = rpc.settings()
  const status = rpc.status()
  const target = resolveMobileAiVaultSessionResumeTarget({
    session: args.session,
    activeWorktreeId: args.activeWorktreeId,
    worktrees: worktrees as (MobileAiVaultWorktree & { terminalPlatform?: NodeJS.Platform })[],
    repos: repos as MobileAiVaultResumeRepo[],
    folderWorkspaces: folderWorkspaces as MobileAiVaultResumeFolderWorkspace[],
    projectGroups: projectGroups as MobileAiVaultResumeProjectGroup[]
  })
  if (target.status !== 'ready') {
    return { status: 'blocked', message: target.message }
  }
  const platform = resolveMobileAiVaultResumePlatform(
    target.targetStatus,
    status.platform,
    target.workspacePath,
    target.terminalPlatform
  )
  if (!platform) {
    return { status: 'blocked', message: 'Unable to determine host platform.' }
  }
  const launch = buildMobileAiVaultResumeLaunch({
    session: await repinCodexHome(args.session, rpc),
    hostPlatform: platform,
    hostTerminalWindowsShell: status.terminalWindowsShell,
    settings: settings as MobileAiVaultResumeSettings | null
  })
  await rpc.createTerminal(target.worktreeId, {
    ...launch,
    clientMutationId: resumeMutationId(args.session)
  })
  const targetWorktree = worktreeById(worktrees, target.worktreeId)
  if (!targetWorktree) {
    throw new Error('selector_not_found')
  }
  return {
    status: 'queued',
    targetIsCurrentWorkspace: targetWorktree.worktreeId === args.activeWorktreeId,
    targetWorktreeId: targetWorktree.worktreeId,
    targetWorkspaceName: (targetWorktree.displayName || 'Worktree').slice(0, 240)
  }
}

/** A retry after an interrupted resume must reuse this key so the host dedups the create; it is
 *  derived from the session, not stored, so a reconnect does not fork the session either. */
function resumeMutationId(session: AiVaultSession): string {
  const safeSession = session.id.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(-96) || 'session'
  return `mobile-web-ai-vault:${safeSession}`
}

/** Per-account and legacy shared Codex homes repin on the host that owns the transcript. */
async function repinCodexHome(
  session: AiVaultSession,
  rpc: ReturnType<typeof mobileWebAgentHistoryRpc>
): Promise<AiVaultSession> {
  const needsAccountRepin =
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  if (
    session.agent !== 'codex' ||
    (!isLegacySharedCodexHome(session.codexHome) && !needsAccountRepin)
  ) {
    return session
  }
  const prepared = await rpc.prepareResume(session)
  if (prepared?.useRealCodexHome === true) {
    return { ...session, codexHome: null }
  }
  return typeof prepared?.substituteCodexHome === 'string' && prepared.substituteCodexHome
    ? { ...session, codexHome: prepared.substituteCodexHome }
    : session
}

function worktreeById(
  worktrees: readonly MobileWebAgentHistoryWorktree[],
  worktreeId: string
): MobileWebAgentHistoryWorktree | undefined {
  return worktrees.find((worktree) => worktree.worktreeId === worktreeId)
}
