import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionLifecycleJournal
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  codexGoalJournalDigest,
  codexGoalJournalIdentity,
  parseCodexGoalJournalItemId,
  type CodexGoalJournalState
} from './codex-goal-journal-identity'
import {
  codexGoalGeneration,
  codexGoalRowSignature,
  isCodexGoalFrameMethod
} from './codex-goal-journal-rows'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import { MAX_CODEX_GOAL_THREADS } from './codex-structured-journal-limits'
import { appendCodexLifecycleTransition } from './codex-structured-journal-sink'

type GoalThreadState = {
  signature: string
  occurrence: string
}

/** Persists provider-owned goal lifecycle notifications outside generic-row policy. */
export class CodexJournalGoals {
  private readonly stateByThread = new Map<string, GoalThreadState>()
  private readonly durableStateByThread = new Map<string, GoalThreadState>()
  private durableJournal: StructuredAgentSessionLifecycleJournal | null = null
  private durableEpoch: string | null = null
  private transientEpoch: string | null = null

  constructor(private readonly sink: StructuredAgentSessionEventSink) {}

  handle(event: {
    threadId: string
    method: string
    params: unknown
  }): CodexJournalTranslationAdmission | null {
    if (!isCodexGoalFrameMethod(event.method)) {
      return null
    }
    const signature = codexGoalRowSignature(event.method, event.params)
    if (signature === null) {
      return null
    }
    this.synchronizeTransientEpoch()
    const thread = codexGoalJournalDigest(event.threadId)
    const reportedGeneration = codexGoalGeneration(event.params)
    const providerGeneration =
      reportedGeneration === null ? null : codexGoalJournalDigest(`provider:${reportedGeneration}`)
    const signatureKey = codexGoalJournalDigest(`${signature}\u0000${providerGeneration ?? ''}`)
    const previous = this.stateByThread.get(thread)
    if (previous?.signature === signatureKey) {
      this.remember(thread, previous)
      return CODEX_JOURNAL_ADMITTED
    }
    const occurrence = previous
      ? codexGoalJournalDigest(JSON.stringify([previous.occurrence, signatureKey]))
      : codexGoalJournalDigest(JSON.stringify([thread, signatureKey]))
    const state = { signature: signatureKey, occurrence }
    const translated = unhandledProviderFrameJournalItem(
      'codex',
      `notification:${event.method}`,
      event.params
    )
    if (!translated) {
      return { accepted: false, reason: 'untranslated' }
    }
    const admission = appendCodexLifecycleTransition(
      this.sink,
      codexGoalJournalIdentity(thread, signatureKey, occurrence),
      translated.body,
      (journal) =>
        this.persistedGoalIdentity(
          journal,
          thread,
          signatureKey,
          event.method === 'thread/goal/cleared'
        )
    )
    if (!admission.accepted) {
      return admission
    }
    this.remember(thread, state)
    return CODEX_JOURNAL_ADMITTED
  }

  clear(): void {
    this.stateByThread.clear()
    this.durableStateByThread.clear()
    this.durableJournal = null
    this.durableEpoch = null
    this.transientEpoch = null
  }

  dispose(): void {
    this.clear()
  }

  private remember(thread: string, state: GoalThreadState): void {
    this.stateByThread.delete(thread)
    this.stateByThread.set(thread, state)
    while (this.stateByThread.size > MAX_CODEX_GOAL_THREADS) {
      const oldest = this.stateByThread.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.stateByThread.delete(oldest)
    }
  }

  private synchronizeTransientEpoch(): void {
    const epoch = this.sink.journalEpoch?.() ?? null
    if (epoch === null) {
      return
    }
    if (this.transientEpoch !== null && this.transientEpoch !== epoch) {
      this.stateByThread.clear()
    }
    this.transientEpoch = epoch
  }

  private persistedGoalIdentity(
    journal: StructuredAgentSessionLifecycleJournal,
    thread: string,
    signature: string,
    requirePrevious: boolean
  ): AgentJournalItemIdentity | null {
    this.seedDurableState(journal)
    const previous = this.durableStateByThread.get(thread) ?? null
    if (previous?.signature === signature) {
      return null
    }
    // Codex sends a cleared snapshot while resuming threads that never had a goal.
    if (previous === null && requirePrevious) {
      return null
    }
    const occurrence = previous
      ? codexGoalJournalDigest(JSON.stringify([previous.occurrence, signature]))
      : codexGoalJournalDigest(JSON.stringify([thread, signature]))
    this.durableStateByThread.set(thread, { signature, occurrence })
    return codexGoalJournalIdentity(thread, signature, occurrence)
  }

  private seedDurableState(journal: StructuredAgentSessionLifecycleJournal): void {
    if (this.durableJournal === journal && this.durableEpoch === journal.epoch) {
      return
    }
    const latest = new Map<string, { state: CodexGoalJournalState; sequence: number }>()
    journal.visitItems((itemId, sequence) => {
      const state = parseCodexGoalJournalItemId(itemId)
      const previous = state ? latest.get(state.thread) : undefined
      if (state && (!previous || sequence > previous.sequence)) {
        latest.set(state.thread, { state, sequence })
      }
    })
    this.durableStateByThread.clear()
    for (const [thread, { state }] of latest) {
      this.durableStateByThread.set(thread, {
        signature: state.signature,
        occurrence: state.occurrence
      })
    }
    this.durableJournal = journal
    this.durableEpoch = journal.epoch
    if (this.transientEpoch !== null && this.transientEpoch !== journal.epoch) {
      this.stateByThread.clear()
    }
    this.transientEpoch = journal.epoch
  }
}
