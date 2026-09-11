import type { AgentJournalTurnLifecycle } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import type { CodexJournalItems } from './codex-structured-journal-items'
import { settleCodexJournalTurn } from './codex-structured-journal-settlement'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import {
  codexTurnLifecycleState,
  codexTurnUserItemId,
  publishCodexTurnLifecycle
} from './codex-structured-journal-translation-turns'
import {
  readCodexTurnDurationMs,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'

type TurnBoundaryEvent = {
  sessionId: string
  threadId: string
  params: unknown
  observedAt?: number
}

/** Opens and settles the durable lifecycle row for each primary-thread turn. */
export class CodexJournalTurnBoundaries {
  constructor(
    private readonly deps: {
      sink: StructuredAgentSessionEventSink
      primaryThreadId: () => string | null
      activeTurns: CodexJournalActiveTurns
      items: Pick<CodexJournalItems, 'streams' | 'activeItems' | 'ordinals'>
      flushSuppression: () => CodexJournalTranslationAdmission
      resetActivity: (threadId: string) => void
      now?: () => number
    }
  ) {}

  start(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (!this.deps.activeTurns.canRemember(event.threadId, turnId)) {
      return { accepted: false, reason: 'backpressure' }
    }
    const startedAt = this.receiptTime(event)
    const admission = publishCodexTurnLifecycle({
      sink: this.deps.sink,
      primaryThreadId: this.deps.primaryThreadId(),
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      state: 'running',
      startedAt
    })
    if (admission.accepted) {
      this.deps.activeTurns.remember(event.threadId, turnId, startedAt)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  complete(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const suppressionAdmission = this.deps.flushSuppression()
    if (!suppressionAdmission.accepted) {
      return suppressionAdmission
    }
    const turnId = readCodexTurnId(event.params) ?? this.deps.activeTurns.current(event.threadId)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    // The roster is deliberately NOT swept here. `spawn_agent` children outlive
    // the turn that spawned them and go on reporting into the same group, so a
    // turn boundary is no evidence contact was lost. Only `settleSession` may
    // write `unverifiable`.
    const admission = settleCodexJournalTurn({
      sink: this.deps.sink,
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      turnLifecycle:
        event.threadId === this.deps.primaryThreadId()
          ? this.settled(
              event.threadId,
              turnId,
              codexTurnLifecycleState(readCodexTurnStatus(event.params)),
              this.receiptTime(event),
              readCodexTurnDurationMs(event.params)
            )
          : null,
      streams: this.deps.items.streams,
      activeItems: this.deps.items.activeItems
    })
    if (admission.accepted) {
      this.deps.items.ordinals.forgetTurn(event.threadId, turnId)
      this.deps.activeTurns.forget(event.threadId, turnId)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Terminal lifecycle for a remembered turn; `startedAt` is absent when the start was never seen. */
  settled(
    threadId: string,
    turnId: string,
    state: 'completed' | 'interrupted',
    completedAt: number,
    durationMs: number | null = null
  ): AgentJournalTurnLifecycle {
    const startedAt = this.deps.activeTurns.startedAt(threadId, turnId)
    return {
      turnId,
      state,
      userItemId: codexTurnUserItemId(threadId, turnId),
      ...(startedAt !== undefined ? { startedAt } : {}),
      completedAt,
      ...(durationMs !== null ? { durationMs } : {})
    }
  }

  private receiptTime(event: TurnBoundaryEvent): number {
    return event.observedAt ?? this.deps.now?.() ?? Date.now()
  }
}
