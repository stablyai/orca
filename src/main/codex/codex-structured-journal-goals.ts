import { createHash } from 'node:crypto'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
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
import { appendCodexLifecycleTransition } from './codex-structured-journal-sink'

type GoalThreadState = {
  signature: string
  occurrence: string
}

const GOAL_IDENTITY_PREFIX = 'codex-goal'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function goalIdentity(
  thread: string,
  signature: string,
  occurrence: string
): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: `${GOAL_IDENTITY_PREFIX}:${thread}:${signature}:${occurrence}`
  }
}

function goalStateFromItem(itemId: string, thread: string): GoalThreadState | null {
  const identity = parseAgentJournalItemKey(itemId)
  if (identity?.provider !== 'orca') {
    return null
  }
  const [prefix, itemThread, signature, occurrence, ...rest] = identity.clientMessageId.split(':')
  return prefix === GOAL_IDENTITY_PREFIX &&
    itemThread === thread &&
    DIGEST_PATTERN.test(signature ?? '') &&
    DIGEST_PATTERN.test(occurrence ?? '') &&
    rest.length === 0
    ? { signature: signature as string, occurrence: occurrence as string }
    : null
}

function persistedGoalIdentity(
  journal: Pick<AgentSessionJournal, 'latestItemIdMatching'>,
  thread: string,
  signature: string
): AgentJournalItemIdentity | null {
  const previousItemId = journal.latestItemIdMatching(
    (itemId) => goalStateFromItem(itemId, thread) !== null
  )
  const previous = previousItemId ? goalStateFromItem(previousItemId, thread) : null
  if (previous?.signature === signature) {
    return null
  }
  const occurrence = previous
    ? digest(JSON.stringify([previous.occurrence, signature]))
    : digest(JSON.stringify([thread, signature]))
  return goalIdentity(thread, signature, occurrence)
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
    const admission = appendCodexLifecycleTransition(
      this.sink,
      goalIdentity(thread, signatureKey, occurrence),
      translated.body,
      (journal) => persistedGoalIdentity(journal, thread, signatureKey)
    )
    if (!admission.accepted) {
      return admission
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
