import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type { CodexThreadItem } from './codex-structured-item-translation'
import type { CodexHelperName } from './codex-collab-agent-item-translation'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type CodexActiveJournalItem = {
  threadId: string
  turnId: string | null
  identity: AgentJournalItemIdentity
  item: CodexThreadItem
  /** Preserve helper names in settled collab-call revisions. */
  helperName?: CodexHelperName
  /** Host start time retained for delayed first writes. */
  startedAt?: number
}

export type CodexJournalTranslatorDeps = {
  account?: () => AgentSessionAccountKind | undefined
  sink: StructuredAgentSessionEventSink
  /** Prevent later connections from revising this connection's frame rows. */
  acquisitionId?: string
  /** Keys restored lifecycle rows to the live identity; without it history restore skips them. */
  sessionId?: string
  /** Catch-up imports use turn-qualified identities without changing live/resume keys. */
  historyImport?: true
  now?: () => number
  bindPromptItemId?: (
    journalItemId: string,
    threadId: string,
    promptKey: string,
    turnId?: string | null
  ) => void
  clearPromptTurn?: (threadId: string, turnId: string) => void
  /** Use the journal row identity so replay computes the same settlement key. */
  onUserMessageEcho?: (clientMessageId: string, identity: AgentJournalItemIdentity) => void
  primaryThreadId?: () => string | null
  /** Submission origin for a dispatch still armed. */
  dispatchRequestOrigin?: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  subagentExecutions?: CodexSubagentExecutions
  coalesceMs?: number
  maxRetainedBytes?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexJournalTranslator = {
  handle: (event: CodexStructuredSessionEvent) => CodexJournalTranslationAdmission
  /** The next primary turn carries this command and determines its end. */
  beginCommand: (command: StructuredAgentSessionCommandRun) => void
  /** The command was never taken. */
  forgetCommand: (turnId: string) => void
  /** The provider turn a Stop naming `turnId` interrupts; undefined while a command has none. */
  commandProviderTurnId: (turnId: string) => string | undefined
  cancelPrompt: (journalItemId: string) => CodexJournalTranslationAdmission
  restoreThread: (
    threadId: string,
    thread: Record<string, unknown>
  ) => CodexJournalTranslationAdmission
  resolvePrompt: (journalItemId: string) => void
  flush: () => void
  dispose: () => void
}

export type CodexJournalTranslationAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' | 'untranslated' }

export type CodexItemTranslation =
  | { handled: false }
  | {
      handled: true
      admission: CodexJournalTranslationAdmission
      dispatchEcho?: { clientMessageId: string; providerIdentity: AgentJournalItemIdentity }
    }

export const CODEX_JOURNAL_ADMITTED = { accepted: true } as const
