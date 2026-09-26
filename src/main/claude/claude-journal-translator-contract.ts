// What the rest of a Claude session asks of its journal translator.

import type { AgentSessionContextReport } from '../../shared/agent-session-context-usage'
import type { StructuredAgentSessionSinkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeChildToolQueries } from './claude-child-tool-queries'
import type { ClaudeContextReportPart, ClaudeContextReportTarget } from './claude-context-facts'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  journalPrompts: Pick<ClaudeJournalPrompts, 'cancel' | 'resolve'>
  /** The open turn's provider id — the same id its journal row carries, and the one
   *  a client's Stop names. Sole owner: no reader keeps a copy to disagree with. */
  readonly currentTurnId: string | null
  flush: () => void
  childToolOwner?: ClaudeChildToolQueries['childToolOwner']
  childActivity?: ClaudeChildToolQueries['childActivity']
  retryPendingTaskRows?: () => StructuredAgentSessionSinkAdmission
  /** Streamed blocks still awaiting a final frame. A settled turn leaves none. */
  readonly pendingStreamedBlocks: number
  /** Moves with the main conversation and each accepted send; a context report
   *  asked for before it moved may no longer describe the context. */
  readonly contextActivity: number
  markContextActivity: () => void
  /** Fires with the turn a fresh `/context` breakdown should be recorded on. */
  subscribeContextUsageRequests: (
    listener: (target: ClaudeContextReportTarget) => void
  ) => () => void
  /** Record a requested breakdown, or only its window, on the turn its request named. */
  recordContextReport: (
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    part: ClaudeContextReportPart
  ) => void
  /** After a write that can change the model or its window; the ring waits for the new window. */
  modelMayHaveChanged: () => void
  /** After a model write the child applied; its name sizes estimates until a window is measured. */
  modelWritten: (model: string) => void
  dispose: () => void
}
