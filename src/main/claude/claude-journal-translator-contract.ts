import type { AgentSessionContextReport } from '../../shared/agent-session-context-usage'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeChildToolQueries } from './claude-child-tool-queries'
import type { ClaudeContextReportPart, ClaudeContextReportTarget } from './claude-context-facts'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import type { ClaudeCommandStart } from './claude-command-turn'

import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { ClaudeGoalBackgroundWork } from './claude-background-task-tracker'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
  onBackgroundTaskJournalFailure?: (error: Error) => void
  account?: () => AgentSessionAccountKind | undefined
  goalBackgroundWork?: () => ClaudeGoalBackgroundWork
}

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  journalPrompts: Pick<
    ClaudeJournalPrompts,
    'resolve' | 'handOver' | 'cancel' | 'openCards' | 'whenWritten'
  >
  /** Canonical provider turn ID used by the journal row and client Stop requests. */
  readonly currentTurnId: string | null
  readonly currentTurnScope: () => AgentJournalTurnScope
  readonly commandTurnId: string | null
  beginCommand: (start: ClaudeCommandStart) => void
  forgetCommand: (turnId: string) => void
  commandInterruptRequested: (turnId: string) => void
  /** Root work since cycle init makes the open turn eligible for folded sends. */
  readonly openTurnInLiveProviderCycle: boolean
  readonly openTurnHasInputWork: boolean
  flush: () => void
  childToolOwner?: ClaudeChildToolQueries['childToolOwner']
  childActivity?: ClaudeChildToolQueries['childActivity']
  retryPendingTaskRows?: () => StructuredAgentSessionSinkAdmission
  retryPendingCancellations?: () => StructuredAgentSessionSinkAdmission
  /** Streamed blocks awaiting final frames; settlement clears them. */
  readonly pendingStreamedBlocks: number
  /** Advances on conversation activity and accepted sends, invalidating older context requests. */
  readonly contextActivity: number
  /** Every final snapshot and turn settlement this acquisition tried was admitted. */
  readonly finalOutputAdmitted: boolean
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
