import type {
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import type { CodexJournalItems } from './codex-structured-journal-items'
import { settleCodexJournalTurn } from './codex-structured-journal-settlement'
import {
  CodexJournalRecentTurns,
  type CodexJournalActiveTurns
} from './codex-structured-journal-translation-turn-state'
import type { CodexDispatchRequestOrigin } from './codex-structured-dispatch-echo'
import {
  codexTurnLifecycleState,
  codexTurnOutcome,
  codexTurnUserItemId,
  publishCodexTurnLifecycle
} from './codex-structured-journal-translation-turns'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
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
  dispatchSequenceAtReceipt?: number
}

/** Opens and settles the durable lifecycle row for each primary-thread turn. */
export class CodexJournalTurnBoundaries {
  private readonly recentTurns = new CodexJournalRecentTurns()

  constructor(
    private readonly deps: {
      sink: StructuredAgentSessionEventSink
      primaryThreadId: () => string | null
      activeTurns: CodexJournalActiveTurns
      items: Pick<CodexJournalItems, 'streams' | 'activeItems' | 'ordinals'>
      pendingPrompts: Map<string, CodexPendingJournalPrompt>
      clearPromptTurn?: (threadId: string, turnId: string) => void
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
      this.deps.activeTurns.remember(
        event.threadId,
        turnId,
        startedAt,
        event.dispatchSequenceAtReceipt
      )
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Revises a turn only after Codex echoes the exact send inside it. */
  attributeRequest(input: {
    sessionId: string
    clientMessageId: string
    threadId: string
    turnId: string
    requestOrigin: CodexDispatchRequestOrigin
  }): CodexJournalTranslationAdmission {
    if (input.threadId !== this.deps.primaryThreadId()) {
      return CODEX_JOURNAL_ADMITTED
    }
    const requestOrigin = {
      ...input.requestOrigin,
      userItemId: agentJournalSubmissionKey(input.clientMessageId)
    }
    const activeRevision = this.deps.activeTurns.requestOriginRevision(
      input.threadId,
      input.turnId,
      requestOrigin
    )
    const settledRevision = activeRevision
      ? null
      : this.recentTurns.requestOriginRevision(input.threadId, input.turnId, requestOrigin)
    const revision = activeRevision ?? settledRevision
    if (!revision) {
      return CODEX_JOURNAL_ADMITTED
    }
    const admission = publishCodexTurnLifecycle({
      sink: this.deps.sink,
      primaryThreadId: this.deps.primaryThreadId(),
      sessionId: input.sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
      state: settledRevision?.state ?? 'running',
      ...revision
    })
    if (admission.accepted) {
      if (activeRevision) {
        this.deps.activeTurns.rememberRequestOrigin(input.threadId, input.turnId, requestOrigin)
      } else if (settledRevision) {
        this.recentTurns.remember(input.threadId, settledRevision, requestOrigin)
      }
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
    const status = readCodexTurnStatus(event.params)
    const turnLifecycle =
      event.threadId === this.deps.primaryThreadId()
        ? this.settled(event.threadId, turnId, {
            state: codexTurnLifecycleState(status),
            outcome: codexTurnOutcome(status),
            completedAt: this.receiptTime(event),
            durationMs: readCodexTurnDurationMs(event.params)
          })
        : null
    const requestOrigin = this.deps.activeTurns.requestOrigin(event.threadId, turnId)
    const latestDispatchSequence = this.deps.activeTurns.latestDispatchSequence(
      event.threadId,
      turnId
    )
    const admission = settleCodexJournalTurn({
      sink: this.deps.sink,
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      turnLifecycle,
      streams: this.deps.items.streams,
      activeItems: this.deps.items.activeItems,
      pendingPrompts: this.deps.pendingPrompts,
      ...(this.deps.clearPromptTurn ? { clearPromptTurn: this.deps.clearPromptTurn } : {})
    })
    if (admission.accepted) {
      if (turnLifecycle) {
        this.recentTurns.remember(
          event.threadId,
          turnLifecycle,
          requestOrigin,
          latestDispatchSequence
        )
      }
      this.deps.items.ordinals.forgetTurn(event.threadId, turnId)
      this.deps.activeTurns.forget(event.threadId, turnId)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Terminal lifecycle for a remembered turn; `startedAt` is absent when the start was never seen.
   *  The verdict travels as one record so a caller cannot supply the state and drop the outcome. */
  settled(
    threadId: string,
    turnId: string,
    terminal: {
      state: 'completed' | 'interrupted'
      completedAt: number
      /** Null when Codex named no verdict, or when the host inferred this end itself. */
      outcome?: AgentJournalTurnOutcome | null
      durationMs?: number | null
    }
  ): AgentJournalTurnLifecycle {
    const startedAt = this.deps.activeTurns.startedAt(threadId, turnId)
    // Carried forward from the exact echoed send that was attributed to this turn.
    const requestOrigin = this.deps.activeTurns.requestOrigin(threadId, turnId)
    return {
      turnId,
      state: terminal.state,
      ...(terminal.outcome ? { outcome: terminal.outcome } : {}),
      userItemId: requestOrigin?.userItemId ?? codexTurnUserItemId(threadId, turnId),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(requestOrigin !== undefined ? { requestedAt: requestOrigin.requestedAt } : {}),
      completedAt: terminal.completedAt,
      ...(terminal.durationMs != null ? { durationMs: terminal.durationMs } : {})
    }
  }

  clear(): void {
    this.deps.activeTurns.clear()
    this.recentTurns.clear()
  }

  private receiptTime(event: TurnBoundaryEvent): number {
    return event.observedAt ?? this.deps.now?.() ?? Date.now()
  }
}
