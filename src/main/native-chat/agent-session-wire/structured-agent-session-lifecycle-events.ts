// What an adapter reports about a child's life: its start, later option reports, and its end.

import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { SubmissionRejectionFact } from '../../../shared/agent-session-failure'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { AgentModelCatalogLiveListing } from '../agent-model-catalog/agent-model-catalog-entry'

export type StructuredAgentSessionEndedEvent = {
  type: 'ended'
  sessionId: string
  /** Log text only; the chat's words come from `failure`. */
  reason: string
  /** Why it ended, as the adapter knows it: the provider's exit with its own diagnostic, or an
   *  Orca fault. Absent reads as a provider exit with nothing to add. */
  failure?: SubmissionRejectionFact
  cause: 'unexpected-exit' | 'requested-close'
  fence: number
  acquisitionGeneration: string
  /** Host receipt of the child exit: the end time of a turn it interrupted. */
  observedAt?: number
  /** The provider ended before it finished starting, so resuming it would repeat the failure. */
  startupUnproven?: true
  /** The provider ended before it answered its start, so it ran nothing it was handed. */
  startupUnanswered?: true
}

/** The child a publish-first acquire handed over has now proven its start: startup facts applied.
 *  What it reports from here on is fact, not a catalog guess. */
export type StructuredAgentSessionStartedEvent = {
  type: 'started'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  /** What the child proved, snapshotted by the adapter from what startup already read. The host
   *  handles this inside the session's serialized step, so it must not ask the CLI. */
  reportedOptions: AgentSessionOptionsResult['current'] & {
    permissionMode?: AgentChatPermissionMode
  }
  /** Saved options the child could not take; the host drops them rather than persist them. */
  restoreSkippedOptions: readonly string[]
  /** Values the child showed it cannot run: a report naming the same value is not persisted. */
  retiredOptions?: Readonly<Record<string, string>>
  /** What the child listed at startup, saved as its account's catalog even if no view reads it. */
  catalogListing?: AgentModelCatalogLiveListing
  /** The attempt's `optionRevision()` as the read behind this report began: a pick the host took
   *  since makes it out of date. An earlier report never does, whenever the host took it. */
  optionRevision: number
}

/** A running child showed saved options it cannot run, as a model the provider reports missing.
 *  The record drops them, so the next start uses the provider's own. */
export type StructuredAgentSessionOptionsSkippedEvent = {
  type: 'options-skipped'
  sessionId: string
  fence: number
  acquisitionGeneration: string
  /** Each saved value the child showed it cannot run; a record holding another value keeps it. */
  options: Readonly<Record<string, string>>
}

/** What a child that already proved its start reports later, such as an optional read that came
 *  after `started`: persisted as the start's report is. Never delays a start. */
export type StructuredAgentSessionOptionsReportedEvent = Omit<
  StructuredAgentSessionStartedEvent,
  'type'
> & { type: 'options-reported' }

export type StructuredAgentSessionLifecycleEvent =
  | StructuredAgentSessionEndedEvent
  | StructuredAgentSessionStartedEvent
  | StructuredAgentSessionOptionsReportedEvent
  | StructuredAgentSessionOptionsSkippedEvent
