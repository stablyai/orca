import type {
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import type { CodexJournalItems } from './codex-structured-journal-items'
import { settleCodexJournalTurn } from './codex-structured-journal-settlement'
import {
  CodexJournalRecentTurns,
  earlierRequestOrigin,
  type CodexJournalActiveTurns,
  type CodexJournalRequestOrigin
} from './codex-structured-journal-translation-turn-state'
import type {
  CodexDispatchEchoes,
  CodexDispatchRequestOrigin
} from './codex-structured-dispatch-echo'
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
import type { CodexJournalCommandTurn } from './codex-journal-command-turn'
import { readRecord, readString } from './codex-item-field-readers'
import { recordCodexCommandTurnClaim } from './codex-command-turn-claim'

type TurnBoundaryEvent = {
  sessionId: string
  threadId: string
  params: unknown
  observedAt?: number
  dispatchSequenceAtReceipt?: number
}

type TurnTerminal = {
  state: 'completed' | 'interrupted'
  completedAt: number
  /** Absent or null when the provider supplied no verdict. */
  outcome?: AgentJournalTurnOutcome | null
  durationMs?: number | null
}

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
      commands: CodexJournalCommandTurn
      turnOpener?: CodexDispatchEchoes['turnOpener']
      now?: () => number
    }
  ) {}

  start(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    const startedAt = this.receiptTime(event)
    const command =
      event.threadId === this.deps.primaryThreadId() ? this.deps.commands.claim(turnId) : null
    const opener = command
      ? null
      : this.replyOpener(event.threadId, turnId, event.dispatchSequenceAtReceipt)
    // Command-owned turns reuse the command's row and scope.
    const admission = command
      ? recordCodexCommandTurnClaim(this.deps.sink, agentJournalItemKey(command.identity), turnId)
      : publishCodexTurnLifecycle({
          sink: this.deps.sink,
          primaryThreadId: this.deps.primaryThreadId(),
          sessionId: event.sessionId,
          threadId: event.threadId,
          turnId,
          state: 'running',
          startedAt,
          ...(opener ? { userItemId: opener.userItemId, requestedAt: opener.requestedAt } : {})
        })
    if (admission.accepted) {
      this.deps.activeTurns.remember(
        event.threadId,
        turnId,
        startedAt,
        event.dispatchSequenceAtReceipt
      )
      if (opener) {
        this.deps.activeTurns.rememberRequestOrigin(event.threadId, turnId, opener)
      }
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

  /** Only turn/completed ends a live turn, including failures preceded by an error frame. */
  complete(event: TurnBoundaryEvent): CodexJournalTranslationAdmission {
    const suppressionAdmission = this.deps.flushSuppression()
    if (!suppressionAdmission.accepted) {
      return suppressionAdmission
    }
    const turnId = readCodexTurnId(event.params) ?? this.deps.activeTurns.current(event.threadId)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    const status = readCodexTurnStatus(event.params)
    const completedAt = this.receiptTime(event)
    const commandEnd = this.deps.commands.end(turnId, {
      status,
      error: readString(readRecord(readRecord(readRecord(event.params).turn).error), 'message'),
      completedAt
    })
    // Stop settles an unstarted send; do not invent a turn record without observed work.
    const ranNothing =
      status === 'interrupted' &&
      !this.deps.activeTurns.has(event.threadId, turnId) &&
      !this.deps.items.ordinals.hasItems(event.threadId, turnId) &&
      ![...this.deps.pendingPrompts.values()].some(
        (prompt) => prompt.threadId === event.threadId && prompt.turnId === turnId
      )
    const turnLifecycle =
      this.ownsRecord(event.threadId, turnId) && !ranNothing
        ? this.settled(event.threadId, turnId, {
            state: codexTurnLifecycleState(status),
            outcome: codexTurnOutcome(status),
            completedAt,
            durationMs: readCodexTurnDurationMs(event.params)
          })
        : null
    const requestOrigin = this.requestOrigin(event.threadId, turnId)
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
      completedAt,
      turnEnd: codexTurnLifecycleState(status),
      streams: this.deps.items.streams,
      activeItems: this.deps.items.activeItems,
      pendingPrompts: this.deps.pendingPrompts,
      ...(this.deps.clearPromptTurn ? { clearPromptTurn: this.deps.clearPromptTurn } : {}),
      attributionFor: this.deps.attributionFor,
      commandEnd
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
      this.deps.commands.settled(turnId)
      this.deps.resetActivity(event.threadId)
    }
    return admission
  }

  /** Keep terminal state and outcome together when revising the remembered turn. */
  settled(threadId: string, turnId: string, terminal: TurnTerminal): AgentJournalTurnLifecycle {
    const startedAt = this.deps.activeTurns.startedAt(threadId, turnId)
    const requestOrigin = this.requestOrigin(threadId, turnId)
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

  ownsRecord(threadId: string, turnId: string): boolean {
    return threadId === this.deps.primaryThreadId() && !this.deps.commands.isCarrying(turnId)
  }

  clear(): void {
    this.deps.activeTurns.clear()
    this.recentTurns.clear()
    this.deps.commands.clear()
  }

  /** The earlier of the echoed and the replied opener; a reply read after turn/started counts too. */
  private requestOrigin(threadId: string, turnId: string): CodexJournalRequestOrigin | undefined {
    const echoed = this.deps.activeTurns.requestOrigin(threadId, turnId)
    const latestDispatchSequence = this.deps.activeTurns.latestDispatchSequence(threadId, turnId)
    const replied =
      latestDispatchSequence === undefined
        ? null
        : this.replyOpener(threadId, turnId, latestDispatchSequence)
    return replied && earlierRequestOrigin(replied, echoed) ? replied : echoed
  }

  /** Codex never echoes a prompt its hook refused, so the turn/start reply names the opener. */
  private replyOpener(
    threadId: string,
    turnId: string,
    latestDispatchSequence = Number.MAX_SAFE_INTEGER
  ): CodexJournalRequestOrigin | null {
    const opener = this.deps.turnOpener?.(threadId, turnId)
    return opener && opener.requestOrigin.sequence <= latestDispatchSequence
      ? { ...opener.requestOrigin, userItemId: agentJournalSubmissionKey(opener.clientMessageId) }
      : null
  }

  private receiptTime(event: TurnBoundaryEvent): number {
    return event.observedAt ?? this.deps.now?.() ?? Date.now()
  }
}
