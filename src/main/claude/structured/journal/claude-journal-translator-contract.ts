import type { ClaudeFullAccessRefusalNotice } from '../permissions/claude-full-access-refusal-notice'
import type { ClaudeTaskInvocations } from '../../background-tasks/claude-task-invocations'
import type { ClaudeJournalBoundDelivery } from './claude-journal-bound-delivery'
import type { AgentSessionContextReport } from '../../../../shared/agent-session/conversation-context/agent-session-context-usage'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeChildToolQueries } from '../../subagents/claude-child-tool-queries'
import type {
  ClaudeContextReportListener,
  ClaudeContextReportTarget
} from '../../context-usage/claude-context-facts'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import type { ClaudeCommandStart } from '../turns/claude-command-turn'
import type { ClaudeOpenTurn } from '../turns/claude-open-turn'
import type { ClaudeCurrentTurn } from '../turns/claude-turn-lifecycle-item'

import type { AgentSessionDeltaCoalescerDeps } from '../../../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type { ClaudeGoalBackgroundWork } from '../../background-tasks/claude-background-task-tracker'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/failures/agent-session-availability'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  delivery?: ClaudeJournalBoundDelivery
  bindPromptItemId?: (journalItemId: string, promptKey: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
  onBackgroundTaskJournalFailure?: (error: Error) => void
  account?: () => AgentSessionAccountKind | undefined
  model?: () => string | undefined
  goalBackgroundWork?: () => ClaudeGoalBackgroundWork
  /** The agent was handed to the terminal host at quit: its open tasks aren't settled. */
  handedOff?: () => boolean
  /** True when this acquisition's pending startup took a turnless failure result and will fail with it. */
  acceptStartupFailure?: (message: Record<string, unknown>) => boolean
  /** True while a send written with priority `now` has not been echoed. */
  steerAwaitingEcho?: () => boolean
  /** The Full access refusal warning this chat is due and has not had yet, else null. */
  fullAccessRefusalNotice?: () => ClaudeFullAccessRefusalNotice | null
}

export type ClaudeJournalTranslator = {
  readonly taskInvocations: ClaudeTaskInvocations
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
  readonly turnCycle: Pick<
    ClaudeOpenTurn,
    'openedInLiveProviderCycle' | 'ownsLiveProviderCycle' | 'confirmProviderCycle' | 'identity'
  >
  readonly openTurnHasInputWork: boolean
  flush: () => void
  childTaskParent?: (taskId: string, run?: string) => string | undefined
  childToolOwner?: ClaudeChildToolQueries['childToolOwner']
  childActivity?: ClaudeChildToolQueries['childActivity']
  retryPendingTaskRows?: () => StructuredAgentSessionSinkAdmission
  retryPendingCancellations?: () => StructuredAgentSessionSinkAdmission
  /** Streamed blocks awaiting final frames; settlement clears them. */
  readonly pendingStreamedBlocks: number
  /** Advances on conversation activity; history catch-up refuses to finish past it. */
  readonly contextActivity: number
  markContextActivity: () => void
  subscribeContextActivity: (listener: () => void) => () => void
  /** Every final snapshot and turn settlement this acquisition tried was admitted. */
  readonly finalOutputAdmitted: boolean
  subscribeContextUsageRequests: (listener: ClaudeContextReportListener) => () => void
  recordContextReport: (
    target: ClaudeContextReportTarget,
    report: AgentSessionContextReport,
    askedAt: number
  ) => void
  /** Defer context estimates until a model change yields a new window. */
  modelMayHaveChanged: () => void
  /** Size interim estimates with the applied model until its window is measured. */
  modelWritten: (model: string) => void
  /** Continue the turn a kept agent was running when the last app quit. */
  adoptKeptTurn: (turn: ClaudeCurrentTurn) => void
  dispose: () => void
}
