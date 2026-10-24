import type { AgentSessionContextReport } from '../../shared/agent-session-context-usage'
import type { StructuredAgentSessionSinkAdmission } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeChildToolQueries } from './claude-child-tool-queries'
import type { ClaudeContextReportPart, ClaudeContextReportTarget } from './claude-context-facts'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { ClaudeCommandStart } from './claude-command-turn'

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  journalPrompts: Pick<
    ClaudeJournalPrompts,
    'resolve' | 'handOver' | 'cancel' | 'openCards' | 'whenWritten'
  >
  /** Canonical provider turn ID used by the journal row and client Stop requests. */
  readonly currentTurnId: string | null
  readonly commandTurnId: string | null
  beginCommand: (start: ClaudeCommandStart) => void
  forgetCommand: (turnId: string) => void
  commandInterruptRequested: (turnId: string) => void
  /** Root work since cycle init makes the open turn eligible for folded sends. */
  readonly openTurnInLiveProviderCycle: boolean
  flush: () => void
  childToolOwner?: ClaudeChildToolQueries['childToolOwner']
  childActivity?: ClaudeChildToolQueries['childActivity']
  retryPendingTaskRows?: () => StructuredAgentSessionSinkAdmission
  retryPendingCancellations?: () => StructuredAgentSessionSinkAdmission
  /** Streamed blocks awaiting final frames; settlement clears them. */
  readonly pendingStreamedBlocks: number
  /** Advances on conversation activity and accepted sends, invalidating older context requests. */
  readonly contextActivity: number
  markContextActivity: () => void
  subscribeContextUsageRequests: (
    listener: (target: ClaudeContextReportTarget) => void
  ) => () => void
  recordContextReport: (
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    part: ClaudeContextReportPart
  ) => void
  /** Defer context estimates until a model change yields a new window. */
  modelMayHaveChanged: () => void
  /** Size interim estimates with the applied model until its window is measured. */
  modelWritten: (model: string) => void
  dispose: () => void
}
