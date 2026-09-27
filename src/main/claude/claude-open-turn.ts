// The session's open turn, and the lifecycle row that publishes it.
//
// Sole owner of turn identity: the row this writes carries the same id it holds,
// and that row's id is what a client's Stop names. Readers ask here rather than
// keeping a copy, so there is nothing to disagree with.

import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeTurnLifecycleIdentity,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import { writeClaudeTurnRow } from './claude-turn-row-revision'
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
  /** Provider output may not reopen a turn after the session ended or a turn
   *  failed: nothing would ever close the turn it opened, and the row would read
   *  working for the life of the session. Only an accepted send lifts it. */
  private reopenSuppressed = false
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
    return this.current
      ? claudeTurnLifecycleIdentity(this.current.sessionId, this.current.turnId)
      : null
  }

  get groupKey(): string | null {
    return this.current ? `${this.current.sessionId}:${this.current.turnId}` : null
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  /** Open a turn, ending whichever one was still open. A new turn starting is the
   *  only end the previous one gets when its result never arrives; settling it
   *  later would sweep THIS turn. */
  open(turn: ClaudeCurrentTurn, observedAt: number): void {
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.settleChildren(this.groupKey)
      this.publish(this.current, { state: 'interrupted', completedAt: observedAt })
    }
    this.current = turn
    this.publish(turn)
    this.deps.sink.setActivity?.(null)
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
