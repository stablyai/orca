import type { AgentSessionContextUsage } from '../../../../shared/agent-session/conversation-context/agent-session-context-usage'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  claudeCurrentTurnIdentity,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import { ClaudeEchoedDispatchStart } from './claude-echoed-dispatch-start'
import type { ClaudeCommandTurn } from './claude-command-turn'
import { createClaudeTurnOpener, type ClaudeTurnSource } from './claude-turn-opening'
import {
  claudeQuotaTurnEndResolution,
  refineClaudeQuotaTurnEnd
} from '../journal/claude-terminal-failure'
import { writeClaudeStopReadings, type ClaudeStopCheck } from '../../claude-stop-readings'
import {
  agentJournalTurnRowReservedBytes,
  writeAgentJournalTurnRow
} from '../../../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { JournalTimelineItemResolution } from '../../../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import type { ClaudeUsageLimitEvidence } from '../journal/claude-usage-limits'
import type { ClaudeDispatchWaiter, ClaudeStartedSend } from '../claude-structured-session-state'

/** The ending a person's Stop at the write position would record instead. */
export type ClaudeStoppedTurnEnd = { check: ClaudeStopCheck; end: ClaudeTurnEnd }

function claudeTurnEndResolution(
  turn: ClaudeCurrentTurn,
  end: ClaudeTurnEnd,
  contextUsage: AgentSessionContextUsage | undefined,
  quotaEnd: boolean
): { resolution: JournalTimelineItemResolution; reservedBytes: number } {
  const item = claudeTurnLifecycleItem(turn, end)
  const write = { lifecycle: item.body, ...(contextUsage ? { contextUsage } : {}) }
  const target = { identity: item.identity }
  return {
    resolution: quotaEnd
      ? claudeQuotaTurnEndResolution(item.identity, write)
      : { kind: 'turn-row', target, write },
    reservedBytes: agentJournalTurnRowReservedBytes(target, write)
  }
}

export type ClaudeOpenTurnDeps = {
  sink: StructuredAgentSessionEventSink
  /** The superseded turn's spawn calls get no announcement now. */
  turnSuperseded: () => void
  /** Ends what the ending turn left open, at the instant it ended; no later frame will. */
  endOpenWork: (sessionId: string | null, completedAt: number, settles?: boolean) => void
  onOpen?: () => void
  steerAwaitingEcho?: () => boolean
}

export class ClaudeOpenTurn {
  private current: ClaudeCurrentTurn | null = null
  readonly echoedDispatchStart = new ClaudeEchoedDispatchStart((startedAt) => {
    if (this.current?.startedAt !== undefined && startedAt < this.current.startedAt) {
      this.current.startedAt = startedAt
      this.publish(this.current)
    }
  })
  usageLimitEvidence: ClaudeUsageLimitEvidence | null = null
  /** Block late output from reopening ended or failed turns until an accepted send arrives. */
  private reopenSuppressed = false
  /** Track root work since cycle init; background output may open a turn before that init. */
  private cycleWorkObserved = false
  private cycleTurn: ClaudeCurrentTurn | null = null
  /** Input choices follow actual work; correlation also includes API errors. */
  inputChoiceWorkObserved = false
  /** The ending of a step a steer cut short, until the steer's own cycle starts. */
  private steerHandoffEnd: ClaudeTurnEnd | null = null
  private startedSend: ClaudeStartedSend | null = null
  private readonly opener: (
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ) => void

  constructor(private readonly deps: ClaudeOpenTurnDeps) {
    this.opener = createClaudeTurnOpener({
      isTurnOpen: () => this.isOpen,
      isSuppressed: () => this.reopenSuppressed,
      steerAwaitingEcho: deps.steerAwaitingEcho,
      startedSend: () => this.startedSend,
      open: (turn, observedAt) => {
        if (this.startedSend) {
          this.allowReopen()
        }
        this.open(turn, observedAt)
      }
    })
  }

  get id(): string | null {
    return this.current?.turnId ?? null
  }

  get identity(): AgentJournalItemIdentity | null {
    return this.current ? claudeCurrentTurnIdentity(this.current) : null
  }

  get command(): ClaudeCommandTurn | null {
    return this.current?.command ?? null
  }

  /** Child rows share their parent turn's scope. */
  get turnScope(): AgentJournalTurnScope {
    const identity = this.identity
    return identity
      ? { kind: 'turn', turnItemId: agentJournalItemKey(identity) }
      : AGENT_JOURNAL_THREAD_SCOPE
  }

  get startedAt(): number | null {
    return this.current?.startedAt ?? null
  }

  get userItemId(): string | null {
    return this.current?.userItemId ?? null
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  /** An open cycle with prior root work can fold a send; its first send remains the opener. */
  get openedInLiveProviderCycle(): boolean {
    return this.current !== null && this.cycleWorkObserved
  }

  get ownsLiveProviderCycle(): boolean {
    return this.current !== null && this.current === this.cycleTurn && this.cycleWorkObserved
  }

  confirmProviderCycle(): void {
    this.cycleTurn = this.current
  }

  /** Reset per frame so send ownership cannot leak into later frames. */
  observeStartedSend(send: ClaudeStartedSend | null): void {
    this.startedSend = send
  }

  /** Stop or idle before the steer runs ends the turn as that step ended, not as completed. */
  holdForSteer(end: ClaudeTurnEnd): void {
    this.steerHandoffEnd = this.current ? end : null
  }

  observeProviderCycleStart(): void {
    this.steerHandoffEnd = null
    this.cycleWorkObserved = false
    this.cycleTurn = null
    this.inputChoiceWorkObserved = false
  }

  observeProviderCycleWork(): void {
    this.cycleWorkObserved = true
  }

  /** Supersede the previous turn before opening another; a missing result must not leave old work live. */
  open(turn: ClaudeCurrentTurn, observedAt: number, reserved = false): void {
    this.echoedDispatchStart.clear()
    this.steerHandoffEnd = null
    this.usageLimitEvidence = null
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.turnSuperseded()
      this.deps.endOpenWork(this.current.sessionId, observedAt)
      this.publish(this.current, {
        state: 'interrupted',
        completedAt: observedAt,
        outcome: 'superseded'
      })
    }
    this.current = turn
    this.cycleTurn = turn
    if (!reserved) {
      this.publish(turn)
    }
    this.deps.sink.setActivity?.(null)
    // Every open clears, since a relaunch can leave the host holding the last process's guess.
    this.deps.sink.setPromptSuggestion?.(null)
  }

  startDispatch(sessionId: string, waiter: ClaudeDispatchWaiter, observedAt: number): void {
    if (this.current?.command?.sentUuid === waiter.sentUuid) {
      this.startCommand(observedAt)
      return
    }
    // A cut-short step still owns its open turn; a fully ended turn leaves the steer free to open.
    if (this.current || waiter.clientMessageId === null) {
      return
    }
    this.allowReopen()
    this.open(
      {
        sessionId,
        turnId: waiter.sentUuid,
        startedAt: observedAt,
        ...(waiter.requestedAt === null ? {} : { requestedAt: waiter.requestedAt }),
        userItemId: agentJournalSubmissionKey(waiter.clientMessageId)
      },
      observedAt
    )
  }

  startCommand(observedAt: number): void {
    if (this.current?.command && this.current.startedAt === undefined) {
      this.current.startedAt = observedAt
      this.publish(this.current)
    }
  }

  /** The host already reserved the command row. */
  beginCommand(turn: ClaudeCurrentTurn): void {
    this.open(turn, turn.startedAt ?? Date.now(), true)
  }

  commandInterruptRequested(turnId: string): void {
    if (this.current?.command && this.current.turnId === turnId) {
      this.current.command.interruptRequested = true
    }
  }

  /** The command was never sent; its turn is the host's to settle. */
  forgetCommand(turnId: string): void {
    if (this.current?.command && this.current.turnId === turnId) {
      this.usageLimitEvidence = null
      this.inputChoiceWorkObserved = false
      this.current = null
      this.cycleTurn = null
    }
  }

  /** Open once for root output; child work stays inside its parent turn. */
  ensureOpen(
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ): void {
    this.opener(frame, source, observedAt)
  }

  /** Settle activity and context facts in the same turn revision. */
  settle(
    settled: ClaudeTurnEnd,
    contextUsage?: AgentSessionContextUsage,
    stopped?: ClaudeStoppedTurnEnd
  ): void {
    this.echoedDispatchStart.clear()
    // Only a verdictless end (idle) takes the held verdict, at idle's time; a real result keeps its own.
    const held = this.steerHandoffEnd
    const end =
      held && settled.outcome === undefined && settled.state === 'completed'
        ? { state: held.state, outcome: held.outcome, completedAt: settled.completedAt }
        : settled
    this.steerHandoffEnd = null
    const quotaEnd = (ending: ClaudeTurnEnd) =>
      this.current !== null &&
      ending.outcome === undefined &&
      this.usageLimitEvidence?.cause === 'quota'
    const readings = {
      ran: quotaEnd(end),
      stopped: stopped !== undefined && quotaEnd(stopped.end)
    }
    this.suppressReopenOnFailure(readings.ran || readings.stopped)
    this.cycleWorkObserved = false
    this.cycleTurn = null
    this.inputChoiceWorkObserved = false
    this.usageLimitEvidence = null
    // End suppressed work even when no turn is open, at the real settle time.
    this.deps.endOpenWork(this.current?.sessionId ?? null, settled.completedAt, true)
    if (this.current) {
      this.publish(
        this.current,
        end,
        contextUsage,
        readings.ran,
        stopped && {
          ...stopped,
          quotaEnd: readings.stopped
        }
      )
      this.current = null
      this.cycleTurn = null
    }
    this.deps.sink.setActivity?.(null)
  }

  allowReopen(): void {
    this.reopenSuppressed = false
  }

  suppressReopen(): void {
    this.reopenSuppressed = true
  }

  /** Keep failure suppression latched until a new accepted send. */
  suppressReopenOnFailure(failed: boolean): void {
    this.reopenSuppressed ||= failed
  }

  private publish(
    turn: ClaudeCurrentTurn,
    end?: ClaudeTurnEnd,
    contextUsage?: AgentSessionContextUsage,
    quotaEnd = false,
    stopped?: ClaudeStoppedTurnEnd & { quotaEnd: boolean }
  ): void {
    const item = claudeTurnLifecycleItem(turn, end)
    const write = {
      lifecycle: item.body,
      ...(contextUsage ? { contextUsage } : {}),
      ...(!end && turn.command ? { onlyWhileRunning: true as const } : {})
    }
    if (end && stopped) {
      const ran = claudeTurnEndResolution(turn, end, contextUsage, quotaEnd)
      const other = claudeTurnEndResolution(turn, stopped.end, contextUsage, stopped.quotaEnd)
      const readings = {
        ran: ran.resolution,
        stopped: other.resolution,
        reservedBytes: Math.max(ran.reservedBytes, other.reservedBytes)
      }
      const options = { ...item.options, lifecycle: true, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      if (
        writeClaudeStopReadings(this.deps.sink, stopped.check, readings, options, {
          publish: false
        })
      ) {
        this.deps.sink.publish({ coalescingKey: item.publishCoalescingKey })
        return
      }
    }
    if (quotaEnd && refineClaudeQuotaTurnEnd(this.deps.sink, item.identity, write)) {
      return
    }
    writeAgentJournalTurnRow(this.deps.sink, { identity: item.identity }, write, {
      publish: false,
      options: { ...item.options, lifecycle: true }
    })
    // Separate keys preserve a queued start publication when the end arrives.
    this.deps.sink.publish({ coalescingKey: item.publishCoalescingKey })
  }
}
