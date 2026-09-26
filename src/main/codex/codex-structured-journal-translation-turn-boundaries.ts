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
import type { CodexRowAttribution } from './codex-subagent-linkage'
import type { CodexJournalTurnScopes } from './codex-journal-turn-scopes'
import { recordCodexCommandTurnClaim } from './codex-command-turn-claim'

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
      attributionFor: CodexRowAttribution
      turnScopes: CodexJournalTurnScopes
      /** The command turn's journal key when a pending conversation command owns this turn. */
      claimCommandTurn?: (threadId: string, turnId: string) => string | null
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
    const commandTurnItemId =
      event.threadId === this.deps.primaryThreadId()
        ? (this.deps.claimCommandTurn?.(event.threadId, turnId) ?? null)
        : null
    // The command's turn is the record: this turn writes none, and its rows join the command's.
    const admission = commandTurnItemId
      ? recordCodexCommandTurnClaim(this.deps.sink, commandTurnItemId, turnId)
      : publishCodexTurnLifecycle({
          sink: this.deps.sink,
          primaryThreadId: this.deps.primaryThreadId(),
          sessionId: event.sessionId,
          threadId: event.threadId,
          turnId,
          state: 'running',
          startedAt
        })
    if (admission.accepted) {
      if (commandTurnItemId) {
        this.deps.turnScopes.claim(turnId, commandTurnItemId)
      }
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
    const turnLifecycle = this.ownsRecord(event.threadId, turnId)
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
      ...(this.deps.clearPromptTurn ? { clearPromptTurn: this.deps.clearPromptTurn } : {}),
      attributionFor: this.deps.attributionFor
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
      this.deps.turnScopes.forget(turnId)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /**
   * Settles the turn a terminal `error` names.
   *
   * Codex reports a fault that ended a turn as an `error` notification carrying
   * that turn's id, and `turn/completed` may never follow it — the app server
   * marks the thread not-running off the error alone. Without this the running
   * lifecycle row is a latch nothing re-derives, and the chat reads "Working"
   * for the life of the session. A retrying stream error is NOT a turn end and
   * never reaches here.
   */
  fail(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const suppressionAdmission = this.deps.flushSuppression()
    if (!suppressionAdmission.accepted) {
      return suppressionAdmission
    }
    const turnId = readCodexTurnId(event.params) ?? this.deps.activeTurns.current(event.threadId)
    // An error naming an already-settled turn is not a second end: its terminal
    // row holds the start and duration this one could not reconstruct.
    if (!turnId || !this.deps.activeTurns.isActive(event.threadId, turnId)) {
      return CODEX_JOURNAL_ADMITTED
    }
    const turnLifecycle = this.ownsRecord(event.threadId, turnId)
      ? this.settled(event.threadId, turnId, {
          state: 'completed',
          outcome: 'failure',
          completedAt: this.receiptTime(event)
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
      ...(this.deps.clearPromptTurn ? { clearPromptTurn: this.deps.clearPromptTurn } : {}),
      attributionFor: this.deps.attributionFor
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
      this.deps.turnScopes.forget(turnId)
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

  /** Whether this translator writes the turn's record: a primary turn no command claimed. */
  ownsRecord(threadId: string, turnId: string): boolean {
    return threadId === this.deps.primaryThreadId() && !this.deps.turnScopes.claimed(turnId)
  }

  clear(): void {
    this.deps.activeTurns.clear()
    this.recentTurns.clear()
    this.deps.turnScopes.clear()
  }

  private receiptTime(event: TurnBoundaryEvent): number {
    return event.observedAt ?? this.deps.now?.() ?? Date.now()
  }
}
