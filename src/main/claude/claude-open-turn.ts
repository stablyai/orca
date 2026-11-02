import type { AgentSessionContextUsage } from '../../shared/agent-session/agent-session-context-usage'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  claudeCurrentTurnIdentity,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import { writeAgentJournalTurnRow } from '../native-chat/agent-session-timeline/agent-journal-turn-row-revision'
import type { ClaudeCommandTurn } from './claude-command-turn'
import {
  createClaudeTurnOpener,
  isRootClaudeFrame,
  type ClaudeTurnSource
} from './claude-turn-opening'
import { refineClaudeQuotaTurnEnd } from './claude-terminal-failure'
import type { ClaudeUsageLimitEvidence } from './claude-usage-limits'
import { ClaudeInputRuns, type ClaudeOfferedInput } from './claude-input-runs'

export type ClaudeOpenTurnDeps = {
  sink: StructuredAgentSessionEventSink
  /** The superseded turn's spawn calls get no announcement now. */
  turnSuperseded: () => void
  /** Ends what the ending turn left open, at the instant it ended; no later frame will. */
  endOpenWork: (completedAt: number) => void
  onOpen?: () => void
}

export class ClaudeOpenTurn {
  private current: ClaudeCurrentTurn | null = null
  usageLimitEvidence: ClaudeUsageLimitEvidence | null = null
  /** Block late output from reopening ended or failed turns until an accepted send arrives. */
  private reopenSuppressed = false
  /** Track root work since cycle init; background output may open a turn before that init. */
  private cycleWorkObserved = false
  /** Input choices follow actual work; correlation also includes API errors. */
  inputChoiceWorkObserved = false
  private readonly runs = new ClaudeInputRuns()
  private readonly opener: (
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ) => void

  constructor(private readonly deps: ClaudeOpenTurnDeps) {
    this.opener = createClaudeTurnOpener({
      isTurnOpen: () => this.isOpen,
      isSuppressed: () => this.reopenSuppressed,
      successor: () => this.runs.successor,
      open: (turn, observedAt, owed) => {
        if (owed) {
          this.allowReopen()
        }
        this.open(turn, observedAt, owed?.clientMessageId)
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

  /** A run with Orca inputs runs on its first input's choices until it ends. */
  get hasInputWork(): boolean {
    return this.current !== null && (this.inputChoiceWorkObserved || this.runs.tracked)
  }

  /** An open cycle with prior root work can fold a send; its first send remains the opener. */
  get openedInLiveProviderCycle(): boolean {
    return this.current !== null && this.cycleWorkObserved
  }

  /** The echo of an input this run owns confirms delivery into it rather than opening another. */
  adoptsEcho(clientMessageId: string): boolean {
    return this.current !== null && this.runs.owns(clientMessageId)
  }

  /** Attribute each frame to the run's inputs and cycle before its effects apply. */
  observeFrame(message: Record<string, unknown>, startsTurn: boolean, clientMessageId?: string) {
    if (!isRootClaudeFrame(message)) {
      return
    }
    this.runs.observe(message, clientMessageId, this.current !== null && this.cycleWorkObserved)
    // Root init starts a cycle; replays after root work fold into it, while task frames do not mark cycle work.
    if (message.type === 'system' && message.subtype === 'init') {
      this.cycleWorkObserved = false
      this.inputChoiceWorkObserved = false
    } else if (startsTurn || message.type === 'assistant' || message.type === 'stream_event') {
      this.cycleWorkObserved = true
      this.inputChoiceWorkObserved ||=
        message.type !== 'assistant' || message.is_api_error_message !== true
    }
  }

  resultEndsRun(message: Record<string, unknown>): boolean {
    return this.runs.resultEndsRun(message)
  }

  endsAtIdle(): boolean {
    return this.runs.endsAtIdle()
  }

  /** Orca's handoff owns the run it starts; a live run gains the input as a member. */
  offerInput(input: ClaudeOfferedInput, observedAt: number): void {
    // A host command's own input belongs to its command row.
    if (this.current?.command?.sentUuid === input.sentUuid) {
      return
    }
    if (!this.runs.offer(input, this.current !== null)) {
      return
    }
    const anchor = this.runs.oldestOwed ?? input
    this.allowReopen()
    this.open(
      this.runTurn(input.sessionId, anchor, observedAt),
      observedAt,
      anchor.clientMessageId,
      true
    )
  }

  /** Claude never ran this input: it leaves its run, and an unworked run left with no input is retracted. */
  withdrawInput(clientMessageId: string): void {
    const current = this.current
    const outcome = this.runs.withdraw(clientMessageId)
    if (!current || current.command || outcome === 'kept') {
      return
    }
    if (outcome === 'reanchor' && this.runs.anchor) {
      this.current = this.runTurn(
        current.sessionId,
        this.runs.anchor,
        current.startedAt,
        current.turnId
      )
      this.publish(this.current)
      return
    }
    this.current = null
    this.runs.end()
    this.deps.sink.appendTombstone(claudeCurrentTurnIdentity(current), { lifecycle: true })
    this.deps.sink.publish({ lifecycle: true })
    this.deps.sink.setActivity?.(null)
  }

  /** Supersede the previous turn before opening another; a missing result must not leave old work live. */
  open(
    turn: ClaudeCurrentTurn,
    observedAt: number,
    anchorClientMessageId?: string,
    offered = false
  ): void {
    this.usageLimitEvidence = null
    this.deps.onOpen?.()
    this.runs.end()
    if (this.current) {
      this.deps.turnSuperseded()
      this.deps.endOpenWork(observedAt)
      this.publish(this.current, {
        state: 'interrupted',
        completedAt: observedAt,
        outcome: 'superseded'
      })
    }
    this.current = turn
    this.runs.begin(anchorClientMessageId ?? null, offered, true)
    this.publish(turn)
    this.deps.sink.setActivity?.(null)
  }

  /** The host already wrote the command row; only publish its eventual end. */
  beginCommand(turn: ClaudeCurrentTurn): void {
    this.usageLimitEvidence = null
    this.deps.onOpen?.()
    if (this.current) {
      this.deps.turnSuperseded()
      this.deps.endOpenWork(turn.startedAt)
      this.publish(this.current, {
        state: 'interrupted',
        completedAt: turn.startedAt,
        outcome: 'superseded'
      })
    }
    this.runs.end()
    this.current = turn
    this.runs.begin(null, false, false)
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
      this.inputChoiceWorkObserved = false
      this.current = null
      this.runs.end()
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
    this.inputChoiceWorkObserved = false
    this.usageLimitEvidence = null
    this.runs.end()
    // End suppressed work even when no turn is open.
    this.deps.endOpenWork(end.completedAt)
    if (this.current) {
      this.publish(this.current, end, contextUsage, quotaEnd)
      this.current = null
    }
    this.deps.sink.setActivity?.(null)
  }

  allowReopen(): void {
    this.reopenSuppressed = false
  }

  /** The child is gone, so nothing it was handed can still run. */
  suppressReopen(): void {
    this.reopenSuppressed = true
    this.runs.reset()
  }

  /** Keep failure suppression latched until a new accepted send. */
  suppressReopenOnFailure(failed: boolean): void {
    this.reopenSuppressed ||= failed
  }

  private runTurn(
    sessionId: string,
    anchor: ClaudeOfferedInput,
    startedAt: number,
    turnId = anchor.sentUuid
  ): ClaudeCurrentTurn {
    return {
      sessionId,
      turnId,
      startedAt,
      ...(anchor.requestedAt === undefined ? {} : { requestedAt: anchor.requestedAt }),
      userItemId: agentJournalSubmissionKey(anchor.clientMessageId)
    }
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
