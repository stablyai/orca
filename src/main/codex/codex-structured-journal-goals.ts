import { createHash } from 'node:crypto'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
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
import { appendCodexLifecycleItem, publishCodexLifecycle } from './codex-structured-journal-sink'

type GoalThreadState = {
  signature: string
  occurrence: string
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function goalIdentity(occurrence: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `codex-goal:${occurrence}` }
}

/** Persists provider-owned goal lifecycle notifications outside generic-row policy. */
export class CodexJournalGoals {
  private readonly stateByThread = new Map<string, GoalThreadState>()

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
    const thread = digest(event.threadId)
    const reportedGeneration = codexGoalGeneration(event.params)
    const providerGeneration =
      reportedGeneration === null ? null : digest(`provider:${reportedGeneration}`)
    const signatureKey = digest(`${signature}\u0000${providerGeneration ?? ''}`)
    const previous = this.stateByThread.get(thread)
    if (previous?.signature === signatureKey) {
      this.remember(thread, previous)
      return CODEX_JOURNAL_ADMITTED
    }
    const occurrence = previous
      ? digest(JSON.stringify([previous.occurrence, signatureKey]))
      : digest(JSON.stringify([thread, signatureKey]))
    const state = { signature: signatureKey, occurrence }
    const translated = unhandledProviderFrameJournalItem(
      'codex',
      `notification:${event.method}`,
      event.params
    )
    if (!translated) {
      return { accepted: false, reason: 'untranslated' }
    }
    const admission = appendCodexLifecycleItem(this.sink, goalIdentity(occurrence), translated.body)
    if (!admission.accepted) {
      return admission
    }
    const published = publishCodexLifecycle(this.sink)
    if (!published.accepted) {
      return published
    }
    this.remember(thread, state)
    return CODEX_JOURNAL_ADMITTED
  }

  clear(): void {
    this.stateByThread.clear()
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
}
