// What the delivery loop reads of the host: its sessions, its queue, the adapter, and the start
// and settlement steps it drives.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Starts a child for `startedFor`, the queued message at the head, if the session has none. */
  ensureProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
  /** Ends the session's child, whose start failed, as a host stop; for a caller inside `serialize`. */
  endFailedStart: (sessionId: string) => Promise<void>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** Rejects queued messages as a completed close of the chat does; false when that failed. */
  abandonQueued: (
    sessionId: string,
    which: (submission: AgentJournalSubmission) => boolean
  ) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  now: () => number
  /** Runs `run` after `delayMs`; answers how to cancel it. */
  setTimer?: (delayMs: number, run: () => void) => () => void
}
