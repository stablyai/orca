import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import { createLaunchedAgentWriteGuard } from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { interruptWorkingAgent } from '../runtime/terminal-agent-interrupt'
import type { ConversationPrompts, PromptTerminal } from './external-conversation-prompts'
import type { ConversationChain } from './external-conversation-chain'
import type { ConversationEvents } from './external-conversation-events'
import { findLink } from './external-conversation-links'
import type { ExternalConversationSeamDeps } from './external-conversation-seam'
import { bindPane } from './external-conversation-send'
import {
  conversationId,
  refused,
  type ConversationKey,
  type Delivery
} from './external-conversation-types'

// Refuse rather than claim cancellation when a host operation ignores abort.
export const CANCEL_SETTLE_TIMEOUT_MS = 5_000

export type CancelTerminal = PromptTerminal & Pick<OrcaRuntimeService, 'getPtyLivenessVerdict'>

export type CancelSeam = Pick<ExternalConversationSeamDeps, 'store' | 'readHookRow'> & {
  prompts: ConversationPrompts
  chain: ConversationChain
  events: ConversationEvents | null
}

/** Cancel queued/held work before rejecting approval, or the rejection could release a follow-up send. */
export async function cancelConversation(
  terminal: CancelTerminal,
  seam: CancelSeam,
  key: ConversationKey,
  signal: AbortSignal
): Promise<Delivery> {
  if (signal.aborted) {
    return refused('connectors_disabled')
  }
  const id = conversationId(key)
  const settling = seam.chain.cancel(id, 'conversation_cancelled')
  // Published launches link before settling; wait before looking up the agent.
  const headRefused = settling
    ? await withTimeout<boolean | null>(settling, CANCEL_SETTLE_TIMEOUT_MS, null)
    : false
  if (signal.aborted) {
    return refused('connectors_disabled')
  }
  if (headRefused === null) {
    return refused('agent_not_reachable')
  }
  const linked = findLink(seam.store, key)
  if (!linked) {
    // Only a refused start proves no unlinked agent needs stopping.
    if (headRefused) {
      return { outcome: 'accepted' }
    }
    if (settling) {
      return refused('agent_not_reachable')
    }
    throw new Error('external_conversation_not_found')
  }
  return stopLinkedAgent(terminal, seam, linked.link, signal)
}

/** Reject approval or send one Escape to a working agent; idle cancellation records a receipt without proving turn end. */
async function stopLinkedAgent(
  terminal: CancelTerminal,
  { prompts, readHookRow, events }: CancelSeam,
  link: ExternalConversationLink,
  signal: AbortSignal
): Promise<Delivery> {
  const pane = bindPane(terminal, link.paneKey)
  // A host out of contact cannot show the agent idle; refused leaves no receipt, so a retry acts.
  if (!pane || terminal.getPtyLivenessVerdict(pane.binding.ptyId)?.status === 'unverifiable') {
    return refused('agent_not_reachable')
  }
  const prompt = prompts.pending(terminal, link)
  if (prompt) {
    return prompt.kind === 'approval'
      ? reject(terminal, prompts, readHookRow, events, link, prompt.promptId, signal)
      : refused('prompt_unsupported')
  }
  // An Escape at a shell that replaced the agent would clear the user's command line.
  const guard = createLaunchedAgentWriteGuard(terminal, link.agent, {
    unprovableHost: 'write-unless-shell'
  })
  try {
    const interrupted = await interruptWorkingAgent(terminal, readHookRow, link.paneKey, {
      beforeWrite: (ptyId) => guard.beforeWrite(ptyId),
      signal
    })
    switch (interrupted.outcome) {
      case 'accepted':
        return interrupted
      case 'unknown':
        return { outcome: 'unknown', reason: 'writer_failed' }
      case 'refused':
        return interrupted.reason === 'agent_not_working'
          ? { outcome: 'accepted' }
          : refused('agent_not_reachable')
    }
  } finally {
    guard.dispose()
  }
}

async function reject(
  terminal: CancelTerminal,
  prompts: ConversationPrompts,
  readHookRow: CancelSeam['readHookRow'],
  events: ConversationEvents | null,
  link: ExternalConversationLink,
  promptId: string,
  signal: AbortSignal
): Promise<Delivery> {
  const row = readHookRow(link.paneKey)
  const binding = bindPane(terminal, link.paneKey)?.binding
  const at = Date.now()
  const delivery = await prompts.answer(terminal, link, {
    promptId,
    optionId: 'reject_once',
    signal
  })
  if (delivery.outcome === 'accepted' && row && binding && !signal.aborted) {
    events?.rejectedByCancel(link.paneKey, row, binding, at)
  }
  return delivery
}
