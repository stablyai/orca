import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type CodexJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  /** Names this connection in frame-row identities, so a later connection never revises its rows. */
  acquisitionId?: string
  /** Keys restored lifecycle rows to the live identity; without it history restore skips them. */
  sessionId?: string
  now?: () => number
  bindPromptItemId?: (
    journalItemId: string,
    threadId: string,
    promptKey: string,
    turnId?: string | null
  ) => void
  clearPromptTurn?: (threadId: string, turnId: string) => void
  /** Settles a send's identity off the echoed user message, using the very
   *  identity the journal row carries so a replay computes the same key. */
  onUserMessageEcho?: (clientMessageId: string, identity: AgentJournalItemIdentity) => void
  primaryThreadId?: () => string | null
  /** Codex reported the primary thread is not running while no turn is open here.
   *  A send whose dispatch was never answered is owed nothing after this. */
  onPrimaryThreadStoppedRunning?: () => void
  /** Submission origin for one exact client message still awaiting its echo. */
  dispatchRequestOrigin?: (clientMessageId: string) => CodexDispatchRequestOrigin | null
  subagentExecutions?: CodexSubagentExecutions
  coalesceMs?: number
  maxRetainedBytes?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexJournalTranslator = {
  handle: (event: CodexStructuredSessionEvent) => CodexJournalTranslationAdmission
  /** Before Orca sends a conversation command: the next primary turn carries it out, and that
   *  turn's end is the command's. */
  beginCommand: (command: StructuredAgentSessionCommandRun) => void
  /** The command was never taken. */
  forgetCommand: (turnId: string) => void
  /** The provider turn a Stop naming `turnId` interrupts; undefined while a command has none. */
  commandProviderTurnId: (turnId: string) => string | undefined
  /** The journal turn provider turn `providerTurnId` writes to: the command's it carries, or its
   *  own. */
  commandJournalTurnId: (providerTurnId: string) => string
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
