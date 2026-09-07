import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { CodexUserMessageEcho } from './codex-structured-dispatch-echo'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

export type CodexJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, threadId: string, promptKey: string) => void
  primaryThreadId?: () => string | null
  /** Fired for every live `userMessage` item; settles echo dispatch waiters. */
  onUserMessageEcho?: (echo: CodexUserMessageEcho) => void
  coalesceMs?: number
  maxRetainedBytes?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

export type CodexJournalTranslator = {
  handle: (event: CodexStructuredSessionEvent) => CodexJournalTranslationAdmission
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
  | { handled: true; admission: CodexJournalTranslationAdmission }

export const CODEX_JOURNAL_ADMITTED = { accepted: true } as const
