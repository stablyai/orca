import { unhandledProviderFrameJournalItem } from '../../../native-chat/agent-session-wire/providers/unhandled-provider-frame'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  codexGoalAccounting,
  codexGoalJournalDigest,
  codexGoalJournalIdentity,
  type CodexGoalAccounting
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
import type { CodexRowAttribution } from '../background-work/codex-subagent-linkage'

type GoalThreadState = {
  signature: string
  occurrence: string
  accounting: CodexGoalAccounting | null
}

// Throttle persisted accounting revisions; readers extrapolate while the turn runs.
const GOAL_ACCOUNTING_REVISION_SECONDS = 30

function accountingOutgrew(
  previous: CodexGoalAccounting | null,
  next: CodexGoalAccounting
): boolean {
  return (
    previous === null ||
    previous.tokenBudget !== next.tokenBudget ||
    Math.abs(next.timeUsedSeconds - previous.timeUsedSeconds) >= GOAL_ACCOUNTING_REVISION_SECONDS
  )
}

/** Persists provider-owned goal lifecycle notifications outside generic-row policy. */
export class CodexJournalGoals {
  private readonly stateByThread = new Map<string, GoalThreadState>()
  private transientEpoch: string | null = null

  constructor(
    private readonly sink: StructuredAgentSessionEventSink,
    private readonly attributionFor: CodexRowAttribution
  ) {}

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
    const translated = unhandledProviderFrameJournalItem(
      'codex',
      `notification:${event.method}`,
      event.params
    )
    if (!translated) {
      return { accepted: false, reason: 'untranslated' }
    }
    const accounting = codexGoalAccounting(translated.body)
    const previous = this.stateByThread.get(thread)
    const sameGoal = previous?.signature === signatureKey
    if (
      previous &&
      sameGoal &&
      (accounting === null || !accountingOutgrew(previous.accounting, accounting))
    ) {
      this.remember(thread, previous)
      return CODEX_JOURNAL_ADMITTED
    }
    // Accounting revisions keep the existing identity and sequence.
    const occurrence =
      previous && sameGoal
        ? previous.occurrence
        : previous
          ? codexGoalJournalDigest(JSON.stringify([previous.occurrence, signatureKey]))
          : codexGoalJournalDigest(JSON.stringify([thread, signatureKey]))
    const state = { signature: signatureKey, occurrence, accounting }
    // The writer chooses the occurrence against the thread's newest saved goal row.
    const admission = appendCodexLifecycleTransition(
      this.sink,
      codexGoalJournalIdentity(thread, signatureKey, occurrence),
      {
        thread,
        signature: signatureKey,
        body: translated.body,
        requirePrevious: event.method === 'thread/goal/cleared'
      },
      // Goals belong to the thread across turns.
      this.attributionFor(event.threadId, null)
    )
    if (!admission.accepted) {
      return admission
    }
    this.remember(thread, state)
    return CODEX_JOURNAL_ADMITTED
  }

  clear(): void {
    this.stateByThread.clear()
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
}
