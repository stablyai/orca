import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { buildAgentSessionContinuationPrompt } from '../../../src/shared/agent-session/context/agent-session-continuation'
import { prepareAiVaultSessionContinuation } from '../../../src/shared/agent-session/context/ai-vault-session-continuation'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { launchAgentInExistingWorkspace } from '../session/agent-launch/mobile-existing-agent-launch'
import { translate } from '../i18n/mobile-i18n'
import type { MobileAiVaultResumeMutationRegistry } from './ai-vault-resume-launch'
import type { MobileHistoryContinuationDestination } from './mobile-history-session-continuation'

export type PendingMobileHistoryHandoff = { prompt: string; operationId: string }

export async function handoffMobileHistorySession(args: {
  client: RpcClient
  session: AiVaultSession
  agent: TuiAgent
  target: { worktreeId: string; workspacePath?: string | null }
  capabilities?: readonly string[]
  assertCurrentOwner: () => void
  mutations: MobileAiVaultResumeMutationRegistry
  handoffs: Map<string, PendingMobileHistoryHandoff>
  mutationKey: string
}): Promise<MobileHistoryContinuationDestination> {
  const key = JSON.stringify([args.mutationKey, args.target.worktreeId, args.agent])
  let pending = args.handoffs.get(key)
  if (!pending) {
    // shortcut: database-backed rows use their preview; add host snapshots when mobile exposes that RPC.
    const request = prepareAiVaultSessionContinuation({
      session: args.session,
      targetWorktreeId: args.target.worktreeId,
      targetWorkspacePath: args.target.workspacePath ?? args.session.cwd ?? ''
    })
    const prompt = buildAgentSessionContinuationPrompt(request.source, 'focused')
    if (!prompt) {
      throw new Error(
        translate(
          'agentHistory.handoff.noContext',
          'No conversation context is available to hand off.'
        )
      )
    }
    pending = { prompt, operationId: args.mutations.claim(key) }
    args.handoffs.set(key, pending)
  }
  const request = pending
  args.assertCurrentOwner()
  const launched = await launchAgentInExistingWorkspace({
    client: args.client,
    hostCapabilities: args.capabilities,
    worktreeId: args.target.worktreeId,
    agent: args.agent,
    prompt: { text: request.prompt, delivery: 'submit' },
    mintOperationId: () => request.operationId,
    assertCurrentOwner: args.assertCurrentOwner
  })
  args.assertCurrentOwner()
  if (launched.kind !== 'launched') {
    throw new Error(
      'message' in launched
        ? launched.message
        : translate(
            'agentHistory.handoff.updateRequired',
            'Update Orca on this host to hand off a session.'
          )
    )
  }
  const unconfirmed =
    launched.promptDelivered !== true || launched.result.prompt?.outcome === 'unconfirmed'
  if (!unconfirmed) {
    args.handoffs.delete(key)
    args.mutations.releaseOnSuccess(key)
  }
  const outcome = launched.result.outcome
  return {
    worktreeId: launched.result.worktreeId,
    ...(outcome.kind === 'terminal' ? { terminal: outcome.handle } : {}),
    paneKey:
      outcome.kind === 'structured'
        ? structuredAgentSessionPaneKey(
            outcome.tabId ?? structuredAgentSessionTabId(outcome.sessionId),
            outcome.sessionId
          )
        : outcome.paneKey,
    ...(unconfirmed
      ? {
          warning: translate(
            'agentHistory.handoff.unconfirmed',
            'The agent started, but context delivery was not confirmed. Check the new session before retrying.'
          )
        }
      : {})
  }
}
