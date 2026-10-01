// The session's open turn, and the lifecycle row that publishes it.
//
// Sole owner of turn identity: the row this writes carries the same id it holds,
// and that row's id is what a client's Stop names. Readers ask here rather than
// keeping a copy, so there is nothing to disagree with.

import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionStopCause } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  claudeCurrentTurnIdentity,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import { writeClaudeTurnRow } from './claude-turn-row-revision'
import type { ClaudeCommandTurn } from './claude-command-turn'
import { createClaudeTurnOpener, type ClaudeTurnSource } from './claude-turn-opening'

export type ClaudeOpenTurnDeps = {
  sink: StructuredAgentSessionEventSink
  /** Settles the superseded turn's children; they get no later event of their own. */
  settleChildren: (groupKey: string | null) => void
  /** A turn opening moves the conversation on. */
  onOpen?: () => void
}

export class ClaudeOpenTurn {
  private current: ClaudeCurrentTurn | null = null
  /** The stop Orca sent, held against the turn it was sent to: it reads only while that turn is open. */
  private sentStop: { turn: ClaudeCurrentTurn; cause: StructuredAgentSessionStopCause } | null =
    null
  /** Provider output may not reopen a turn after the session ended or a turn
   *  failed: nothing would ever close the turn it opened, and the row would read
   *  working for the life of the session. Only an accepted send lifts it. */
  private reopenSuppressed = false
  /** Whether the provider's current request cycle has done root work — a send
   *  echo or model output — since its init. Output can open a turn ahead of its
   *  cycle's init (a background task finishing), so membership is read from the
   *  cycle's work, not from when the turn opened. */
  private cycleWorkObserved = false
  private readonly opener: (
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ) => void

  constructor(private readonly deps: ClaudeOpenTurnDeps) {
    this.opener = createClaudeTurnOpener({
      isTurnOpen: () => this.isOpen,
      isSuppressed: () => this.reopenSuppressed,
      open: (turn, observedAt) => this.open(turn, observedAt)
    })
  }

  get id(): string | null {
    return this.current?.turnId ?? null
  }

  /** The open turn's row, where a fact about the running turn lands. */
  get identity(): AgentJournalItemIdentity | null {
    return this.current ? claudeCurrentTurnIdentity(this.current) : null
  }

  /** The conversation command the open turn is, if it is one. */
  get command(): ClaudeCommandTurn | null {
    return this.current?.command ?? null
  }

  /** Which turn a row written now belongs to: the open one, or none. A subagent's rows too —
   *  its work is its parent turn's. */
  get turnScope(): AgentJournalTurnScope {
    const identity = this.identity
    return identity
      ? { kind: 'turn', turnItemId: agentJournalItemKey(identity) }
      : AGENT_JOURNAL_THREAD_SCOPE
  }

  get groupKey(): string | null {
    return this.current ? `${this.current.sessionId}:${this.current.turnId}` : null
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  get stop(): StructuredAgentSessionStopCause | null {
    return this.current && this.sentStop?.turn === this.current ? this.sentStop.cause : null
  }

  /** Orca is stopping `turnId`. False when that turn is no longer the open one. */
  recordStop(turnId: string, cause: StructuredAgentSessionStopCause): boolean {
    if (this.current?.turnId !== turnId) {
      return false
    }
    this.sentStop = { turn: this.current, cause }
    return true
  }

  /** The provider refused the stop, so the turn goes on as if none was sent. */
  withdrawStop(turnId: string): void {
    if (this.current?.turnId === turnId) {
      this.sentStop = null
    }
  }

  /** Whether a turn is open inside a provider request cycle that has already
   *  done work — the state in which the CLI folds an arriving send into it. A
   *  cycle's first send is its opener, never a fold. */
  get openedInLiveProviderCycle(): boolean {
    return this.current !== null && this.cycleWorkObserved
  }

  /** A root init frame: the CLI is starting a new request cycle. */
  observeProviderCycleStart(): void {
    this.cycleWorkObserved = false
  }

  /** A root send echo or model output inside the current request cycle. */
  observeProviderCycleWork(): void {
    this.cycleWorkObserved = true
  }

  /** Open a turn, ending whichever one was still open. A new turn starting is the
   *  only end the previous one gets when its result never arrives; settling it
   *  later would sweep THIS turn. The replaced turn is recorded superseded: a newer
   *  request ended it, whoever sent that request. */
  open(turn: ClaudeCurrentTurn, observedAt: number): void {
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.settleChildren(this.groupKey)
      this.publish(this.current, {
        state: 'interrupted',
        completedAt: observedAt,
        outcome: 'superseded'
      })
    }
    this.current = turn
    this.publish(turn)
    this.deps.sink.setActivity?.(null)
  }

  /** A conversation command the host opened a turn for. Its row is the host's, already written,
   *  so only an end is published; the command's result is what ends it. */
  beginCommand(turn: ClaudeCurrentTurn): void {
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.settleChildren(this.groupKey)
      this.publish(this.current, {
        state: 'interrupted',
        completedAt: turn.startedAt,
        outcome: 'superseded'
      })
    }
    this.current = turn
    this.deps.sink.setActivity?.(null)
  }

  /** Orca asked the provider to stop the command `turnId` names. */
  commandInterruptRequested(turnId: string): void {
    if (this.current?.command && this.current.turnId === turnId) {
      this.current.command.interruptRequested = true
    }
  }

  /** The command was never sent; its turn is the host's to settle. */
  forgetCommand(turnId: string): void {
    if (this.current?.command && this.current.turnId === turnId) {
      this.current = null
    }
  }

  /** The provider produced, so a turn is running. Idempotent: every frame of one
   *  reply stays inside the turn its first frame opened. A subagent's output is
   *  its parent turn's work and never a turn of its own. */
  ensureOpen(
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ): void {
    this.opener(frame, source, observedAt)
  }

  /** End the open turn, if one is open, and clear the live activity line. The
   *  context facts the end brings ride the same revision. */
  settle(end: ClaudeTurnEnd, contextUsage?: AgentSessionContextUsage): void {
    // Every settle is a provider cycle ending (result, idle, child exit).
    this.cycleWorkObserved = false
    if (this.current) {
      this.publish(this.current, end, contextUsage)
      this.current = null
    }
    this.deps.sink.setActivity?.(null)
  }

  /** An accepted send is the only thing that lifts the latch. */
  allowReopen(): void {
    this.reopenSuppressed = false
  }

  suppressReopen(): void {
    this.reopenSuppressed = true
  }

  /** A turn that failed is not resumed by whatever the provider says next; the
   *  next send is what resumes it. The latch only ever sets here. */
  suppressReopenOnFailure(failed: boolean): void {
    this.reopenSuppressed ||= failed
  }

  /** Deliberately root: a turn is the SESSION'S unit of work, and this lane only
   *  ever opens turns for the session's own agent. A child runs inside one. */
  private publish(
    turn: ClaudeCurrentTurn,
    end?: ClaudeTurnEnd,
    contextUsage?: AgentSessionContextUsage
  ): void {
    const item = claudeTurnLifecycleItem(turn, end)
    writeClaudeTurnRow(
      this.deps.sink,
      { identity: item.identity },
      { lifecycle: item.body, ...(contextUsage ? { contextUsage } : {}) },
      { publish: false, options: item.options }
    )
    // Preserve first-work evidence when completion arrives before the journal drains.
    this.deps.sink.publish({ coalescingKey: item.publishCoalescingKey })
  }
}
