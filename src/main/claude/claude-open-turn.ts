import type { AgentSessionContextUsage } from '../../shared/agent-session-context-usage'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeCurrentTurnIdentity,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import type { StructuredAgentSessionTransitionStep } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite,
  writeAgentJournalTurnRow
} from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { ClaudeCommandTurn } from './claude-command-turn'
import { createClaudeTurnOpener, type ClaudeTurnSource } from './claude-turn-opening'
import { claudeQuotaTurnEndStep, refineClaudeQuotaTurnEnd } from './claude-terminal-failure'
import type { ClaudeUsageLimitEvidence } from './claude-usage-limits'
import type { ClaudeStartedSend } from './claude-structured-session-state'

export type ClaudeOpenTurnDeps = {
  sink: StructuredAgentSessionEventSink
  /** The superseded turn's spawn calls get no announcement now. */
  turnSuperseded: () => void
  /** Ends what the ending turn left open, at the instant it ended; no later frame will. */
  endOpenWork: (
    completedAt: number,
    settlement?: StructuredAgentSessionTransitionStep
  ) => boolean | void
  /** A turn opening moves the conversation on. */
  onOpen?: () => void
}

export class ClaudeOpenTurn {
  private current: ClaudeCurrentTurn | null = null
  usageLimitEvidence: ClaudeUsageLimitEvidence | null = null
  /** Block late output from reopening ended or failed turns until an accepted send arrives. */
  private reopenSuppressed = false
  /** Track root work since cycle init; background output may open a turn before that init. */
  private cycleWorkObserved = false
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

  get isOpen(): boolean {
    return this.current !== null
  }

  /** An open cycle with prior root work can fold a send; its first send remains the opener. */
  get openedInLiveProviderCycle(): boolean {
    return this.current !== null && this.cycleWorkObserved
  }

  /** Reset per frame so send ownership cannot leak into later frames. */
  observeStartedSend(send: ClaudeStartedSend | null): void {
    this.startedSend = send
  }

  observeProviderCycleStart(): void {
    this.cycleWorkObserved = false
  }

  observeProviderCycleWork(): void {
    this.cycleWorkObserved = true
  }

  /** Supersede the previous turn before opening another; a missing result must not leave old work live. */
  open(turn: ClaudeCurrentTurn, observedAt: number): void {
    this.usageLimitEvidence = null
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.turnSuperseded()
      if (!this.finish({ state: 'interrupted', completedAt: observedAt, outcome: 'superseded' })) {
        return
      }
    }
    this.current = turn
    this.publish(turn)
    this.deps.sink.setActivity?.(null)
  }

  /** The host already wrote the command row; only publish its eventual end. */
  beginCommand(turn: ClaudeCurrentTurn): void {
    this.usageLimitEvidence = null
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.turnSuperseded()
      if (
        !this.finish({ state: 'interrupted', completedAt: turn.startedAt, outcome: 'superseded' })
      ) {
        return
      }
    }
    this.current = turn
    this.deps.sink.setActivity?.(null)
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
      this.current = null
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
  settle(end: ClaudeTurnEnd, contextUsage?: AgentSessionContextUsage): void {
    const quotaEnd =
      this.current !== null &&
      end.outcome === undefined &&
      this.usageLimitEvidence?.cause === 'quota'
    this.suppressReopenOnFailure(quotaEnd)
    this.cycleWorkObserved = false
    this.usageLimitEvidence = null
    // Even with no turn open: work a suppressed turn produced still ends here.
    if (!this.finish(end, contextUsage, quotaEnd)) {
      return
    }
    this.current = null
    this.deps.sink.setActivity?.(null)
  }

  private finish(
    end: ClaudeTurnEnd,
    contextUsage?: AgentSessionContextUsage,
    quotaEnd = false
  ): boolean {
    const turn = this.current
    if (!this.deps.sink.tryAppendTransition) {
      if (this.deps.endOpenWork(end.completedAt) === false) {
        return false
      }
      if (turn) {
        this.publish(turn, end, contextUsage, quotaEnd)
      }
      return true
    }
    const item = turn ? claudeTurnLifecycleItem(turn, end) : null
    const target = item ? { identity: item.identity } : null
    const write = item ? { lifecycle: item.body, ...(contextUsage ? { contextUsage } : {}) } : null
    const reservedBytes = target && write ? agentJournalTurnRowReservedBytes(target, write) : 0
    const step: StructuredAgentSessionTransitionStep | undefined =
      item && target && write
        ? ((quotaEnd ? claudeQuotaTurnEndStep(this.deps.sink, item.identity, write) : null) ?? {
            kind: 'item',
            reservedBytes,
            resolve: (journal) =>
              resolveAgentJournalTurnRowWrite(journal, target, write, reservedBytes),
            options: { ...item.options, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          })
        : undefined
    return this.deps.endOpenWork(end.completedAt, step) !== false
  }

  /** An accepted send is the only thing that lifts the latch. */
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
    quotaEnd = false
  ): void {
    const item = claudeTurnLifecycleItem(turn, end)
    const write = { lifecycle: item.body, ...(contextUsage ? { contextUsage } : {}) }
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
