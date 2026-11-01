import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import type { RpcClient } from '../transport/rpc-client'
import { loadMobileResumeMetadata } from './mobile-agent-history-resume-metadata'
import { resolveMobileAiVaultSessionResumeTarget } from './agent-history-resume-target'
import { resolveMobileAiVaultResumePlatform } from '../session/ai-vault-resume-launch'

/** Resolve terminal fallback only from the live owning-host catalog. */
export async function prepareMobileHistoryResumeTarget(args: {
  client: RpcClient
  session: AiVaultSession
  worktreeId: string
  worktrees: readonly Worktree[]
  hostPlatform: NodeJS.Platform | null
  assertCurrentOwner: () => void
  unknownPlatformMessage: () => string
}) {
  const {
    settings,
    worktrees: freshWorktrees,
    ...catalog
  } = await loadMobileResumeMetadata(args.client)
  args.assertCurrentOwner()
  const target = resolveMobileAiVaultSessionResumeTarget({
    session: args.session,
    activeWorktreeId: args.worktreeId,
    // Deleted workspaces cannot be selected after a successful catalog refresh.
    worktrees: freshWorktrees ?? args.worktrees,
    catalog,
    hostPlatform: args.hostPlatform
  })
  if (target.status !== 'ready') {
    return target
  }
  const platform = resolveMobileAiVaultResumePlatform(
    target.targetStatus,
    args.hostPlatform,
    target.workspacePath,
    target.terminalPlatform
  )
  return platform
    ? ({ status: 'ready', target, platform, settings } as const)
    : ({ status: 'blocked', message: args.unknownPlatformMessage() } as const)
}
