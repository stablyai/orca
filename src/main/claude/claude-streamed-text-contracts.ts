import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  AgentSessionDeltaWindow,
  AgentSessionDeltaSource,
  AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionTransitionStep } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

export type ClaudeStreamedTextCheckpointDeps = {
  /** Rewrites the block's journal row with the text accumulated so far. `ended` is set on the
   *  block's last write, when it ends without the final frame that would otherwise replace it. */
  persist: (
    identity: AgentJournalItemIdentity,
    text: string,
    options: StructuredAgentSessionAppendOptions,
    ended?: ClaudeStreamedBlockEnd
  ) => boolean | void
  persistDelta?: (
    identity: AgentJournalItemIdentity,
    window: AgentSessionDeltaWindow,
    options: StructuredAgentSessionAppendOptions
  ) => boolean
  /** Who produced a block, asked by the scope the block streamed under. */
  persistPrepared?: (block: ClaudePreparedTextEnd, ended?: ClaudeStreamedBlockEnd) => boolean
  prepareText?: StructuredAgentSessionEventSink['prepareText']
  source?: (identity: AgentJournalItemIdentity) => AgentSessionDeltaSource | undefined
  producer: ClaudeSubagentLinkageSource
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

/** How a block ended: `completedAt` is when the host saw it end, or saw what cut it off. */
export type ClaudeStreamedBlockEnd = { completedAt?: number }

export type ClaudePreparedTextEnd = {
  identity: AgentJournalItemIdentity
  startedAt?: number
  scope: string | null
  readonly text: string | undefined
  hasText: boolean
  step: (
    body: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions,
    finish?: boolean
  ) => StructuredAgentSessionTransitionStep
  options: StructuredAgentSessionAppendOptions
  forget: () => void
}

export type ClaudeStreamedTextSelection = (
  key: string,
  block: Pick<ClaudePreparedTextEnd, 'identity' | 'scope'>
) => boolean

export type ClaudeStreamedTextCheckpoints = {
  prepareFinish: (
    only?: ClaudeStreamedTextSelection,
    extra?: { identity: AgentJournalItemIdentity; text: string }
  ) => ClaudePreparedTextEnd[]
  startedAt: (key: string) => number | undefined
  /** Accumulate a delta; the row is rewritten on the coalescer's own cadence. */
  append: (
    identity: AgentJournalItemIdentity,
    text: string,
    parentToolUseId?: string | null,
    startedAt?: number
  ) => boolean
  /** Write every block whose row is behind the text received for it. */
  flush: () => void
  /** Rewrite every block whose producer now resolves differently. A block that
   *  stopped streaming before its announcement is never revisited otherwise,
   *  and would keep a provisional id no later checkpoint comes to correct. */
  reattribute: () => void
  /** Drop one block's state, for a block whose final frame has now landed. */
  forget: (key: string) => void
  /** The text received for a block so far, if it is still streaming. */
  latest: (key: string) => string | undefined
  /** Write each matching block's text one last time as ended, then drop it: its final frame is
   *  never coming. A block with no text has no row and is only dropped. */
  finish: (ended: ClaudeStreamedBlockEnd, only?: ClaudeStreamedTextSelection) => boolean
  /** Blocks still awaiting a final frame. A settled turn must leave none. */
  readonly pending: number
  dispose: () => void
}
