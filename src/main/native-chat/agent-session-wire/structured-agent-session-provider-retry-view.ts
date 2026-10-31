import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionTransientFailure } from '../../../shared/agent-session-provider-retry-policy'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionCurrentWorkJournal } from './structured-agent-session-current-work'

export type ProducerTransition = {
  /** Local producer purpose; attribution and restored bodies confer no live start. */
  turnLifecycle?: { identity: AgentJournalItemIdentity; state: 'start' | 'end' }
  transientTerminal?: { identity: AgentJournalItemIdentity; category: AgentSessionTransientFailure }
}
export type ProviderRetryCompletion = { owner: object; itemId: string }
export type ProviderRetryDisposition = 'consume' | 'release' | 'abandon'
export type View = {
  completion: () => ProviderRetryCompletion | null
  finishAborted: () => boolean
  pending: () => boolean
  stop: () => { turnId: string; written: boolean } | null
  retire: () => boolean
  stage: (transition: ProducerTransition) => () => void
}

export const owners = new WeakMap<object, View>()
export const structuredAgentSessionProviderRetryPending = (
  journal: StructuredAgentSessionCurrentWorkJournal
): boolean => owners.get(journal)?.pending() ?? false
export const structuredAgentSessionProviderRetryStop = (journal: AgentSessionJournal) =>
  owners.get(journal)?.stop() ?? null
export const structuredAgentSessionProviderRetryCompletion = (journal: AgentSessionJournal) =>
  owners.get(journal)?.completion() ?? null
export const finishAbortedStructuredAgentSessionProviderRetry = (journal: AgentSessionJournal) =>
  owners.get(journal)?.finishAborted() ?? false
export const retireStructuredAgentSessionProviderRetry = (journal: AgentSessionJournal): boolean =>
  owners.get(journal)?.retire() ?? false
export function stageStructuredAgentSessionProviderTransition(
  journal: AgentSessionJournal,
  transition: ProducerTransition
): (() => void) | undefined {
  return owners.get(journal)?.stage(transition)
}
