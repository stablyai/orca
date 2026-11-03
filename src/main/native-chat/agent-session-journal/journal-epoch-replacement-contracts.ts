import type {
  AgentJournalCursor,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { JournalItemEcho } from './journal-item-echo'
import type { JournalLoad } from './journal-open'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalEpochReason } from './journal-row-schema'
import type { JournalOperationReceipt } from './journal-row-writer'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import type { JournalQueueRestatement } from './journal-queued-messages'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  echoOf?: JournalItemEcho['echoOf']
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Derive absent legacy scopes from timeline position before persisting them. */
  turnScope?: AgentJournalTurnScope
  /** Preserve original execution provenance; history replacement is not new work. */
  ownerFence: number
  executionOwner?: number
}

/** Survivors are restated from the open chat. That loses nothing another build wrote: a chat holding
 * a key this build does not declare refuses to open, so no handle can reach here. */
export type JournalEpochReplacementInput = {
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  /** The caller's completion receipt writes after the new epoch's records, in the same
   * transaction, so it can restore the replaced conversation on `db`. */
  receipt?: (cursor: AgentJournalCursor) => JournalOperationReceipt
  isLiveGoal?: (id: string) => boolean
  claimAttachments?: JournalAttachmentClaim
  previous?: JournalReducerState
  /** Preserve Stop/Resume state so rewinds cannot release held cards or resurrect lifted pauses. */
  queuePause: JournalQueuePauseRestatement
  /** Restate cards before carried submissions relink their handoffs. */
  queue: JournalQueueRestatement
  now: () => number
  mintEpoch: () => string
  /** Adopt committed state before fallible follow-up work. */
  onPublished: (loaded: JournalLoad) => void | Promise<void>
  publish?: () => void
}
