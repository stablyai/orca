// Preserve event order across journal backpressure; hold later events until the sink accepts.

import type { StructuredAgentSessionChildWorkProducer } from '../native-chat/agent-session-wire/structured-agent-session-subagent-rows'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { AcpTimelineEvent } from './acp-timeline-event'
import { acpPromptTurnId } from './acp-prompt-turns'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import {
  acpBackgroundTaskChildWork,
  isAcpBackgroundTaskChildWorkEvent
} from './acp-background-task-child-work'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AcpTextDrop } from './acp-turn-messages'

const BACKPRESSURE_RETRY_MS = 250

// Publish child-work evidence only after preceding journal events commit.
type SubagentWork = { type: 'subagent.work'; evidence: AgentChildWorkEvidence[] }

export type AcpStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  agentName: string
  generation: string
  providerSessionId: string
  dialect: AcpDialect
  logger: StructuredAgentSessionLogger
  /** First provider event confirms receipt of an Orca send. */
  onInputAccepted: (clientMessageId: string) => void
  /** Permanent sink refusal prevents further journaling. */
  onFailed: (reason: string) => void
  onChildWorkEvidence?: (evidence: AgentChildWorkEvidence[]) => void
  onChildWorkFailure?: (error: unknown) => void
  now?: () => number
  childStops?: () => AcpChildStops
}

export class AcpStructuredLane {
  readonly translator: AcpTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: (AcpTimelineEvent | SubagentWork)[] = []
  private readonly turnWatchers = new Set<() => void>()
  private readonly requestIdentity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private ended = false
  private disposed = false
  private readonly logger: StructuredAgentSessionLogger

  constructor(private readonly deps: AcpStructuredLaneDeps) {
    this.logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
    this.translator = new AcpTimelineTranslator({
      sessionId: deps.providerSessionId,
      dialect: deps.dialect,
      agentName: deps.agentName,
      onTextDropped: (drop) => this.reportTextDrop(drop)
    })
    this.requestIdentity = createLegacyProviderTimelineIdentityScheme({
      agent: deps.agent,
      sessionId: deps.sessionId
    })
    this.assembler = createProviderTimelineAssembler({
      sink: deps.sink,
      sessionId: deps.sessionId,
      agent: deps.agent,
      generation: deps.generation,
      namespace: deps.providerSessionId
    })
  }

  hasPendingDiagnostic(clientMessageId: string): boolean {
    const turn = acpPromptTurnId(clientMessageId)
    return (
      !this.failed &&
      !this.disposed &&
      !this.ended &&
      this.backlog.some(
        (event) =>
          event.type === 'item.update' &&
          event.body.kind === 'status' &&
          !event.producer &&
          event.join?.thread === this.deps.providerSessionId &&
          event.join.turn === turn
      )
    )
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    if (this.failed || this.disposed || this.backlog.length > 0) {
      throw new Error('ACP timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly AcpTimelineEvent[]): void {
    if (this.failed || this.disposed) {
      return
    }
    this.backlog.push(...events)
    const evidence = this.translator.subagents.drainEvidence()
    if (evidence.length > 0) {
      this.backlog.push({ type: 'subagent.work', evidence })
    }
    this.drain()
  }

  /** Resolves when the turn leaves or further writes become impossible. */
  whenTurnLeaves(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.failed || this.disposed || this.openTurnId !== turnId) {
          this.turnWatchers.delete(check)
          resolve()
        }
      }
      this.turnWatchers.add(check)
      check()
    })
  }

  retry(): void {
    this.drain()
  }

  /** Matches this acquisition's request row, including reused-key incarnations. */
  isRequestRow(itemId: string, requestKey: string): boolean {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'legacy' || identity.sessionId !== this.deps.sessionId) {
      return false
    }
    const first = this.requestIdentity.request({
      generation: this.deps.generation,
      key: requestKey,
      incarnation: 1
    })
    const prefix = first.provider === 'legacy' ? first.recordId : null
    return identity.recordId === prefix || identity.recordId.startsWith(`${prefix}#`)
  }

  flush(): void {
    this.assembler.flush()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.translator.dispose()
    this.clearRetry()
    this.backlog.length = 0
    this.assembler.dispose()
    this.notifyTurnWatchers()
    // Observation has ended even if its journal edge was refused; drain admitted snapshots first.
    void Promise.resolve(this.deps.sink.written?.()).then(
      () => this.publishSessionEnd(),
      () => this.publishSessionEnd()
    )
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]
      if (event.type === 'subagent.work') {
        if (!this.queueSubagentWork(event.evidence)) {
          return
        }
        this.backlog.shift()
        continue
      }
      const { admission, dropped } = this.assembler.apply(
        event,
        event.type === 'session.ended'
          ? () => this.publishSessionEnd()
          : isAcpBackgroundTaskChildWorkEvent(event)
            ? () => this.publishChildWork(event)
            : undefined
      )
      if (dropped === 'stream-mismatch' && event.type === 'text.delta') {
        this.reportTextDrop({
          reason: dropped,
          itemId: 'id' in event.item ? event.item.id : undefined,
          channel: event.channel,
          threadId: event.join?.thread,
          turnId: event.join?.turn,
          producerAgentId: event.producer?.agentId
        })
      }
      if (!admission.accepted) {
        this.refused(admission.reason)
        return
      }
      this.backlog.shift()
      // Ignore live-child evidence after session end.
      this.ended ||= event.type === 'session.ended' && dropped === undefined
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
    this.notifyTurnWatchers()
  }

  private publishChildWork(event: AcpTimelineEvent): void {
    const observedAt = this.deps.now?.() ?? Date.now()
    const stops = this.deps.childStops?.()
    const evidence = acpBackgroundTaskChildWork(event, observedAt, stops?.backgroundTasks === true)
    if (evidence.length > 0) {
      this.publishEvidence(evidence)
    }
  }

  private refused(reason: string): void {
    if (reason === 'backpressure') {
      this.retryTimer = setTimeout(() => this.drain(), BACKPRESSURE_RETRY_MS)
      return
    }
    this.failed = true
    this.backlog.length = 0
    this.notifyTurnWatchers()
    this.deps.onFailed(reason)
  }

  private queueSubagentWork(evidence: AgentChildWorkEvidence[]): boolean {
    if (this.ended) {
      return true
    }
    const admission = this.deps.sink.tryAppendTransition({
      steps: [],
      lifecycle: false,
      publish: false,
      onPublished: () => this.publishSubagentWork(evidence)
    })
    if (!admission.accepted) {
      this.refused(admission.reason)
    }
    return admission.accepted
  }

  private publishSubagentWork(evidence: AgentChildWorkEvidence[]): void {
    const stoppable = this.deps.childStops?.().subagents === true
    this.publishEvidence(
      evidence.map((edge) =>
        edge.type === 'live'
          ? { ...edge, child: { ...edge.child, stoppable: stoppable && edge.child.stoppable } }
          : edge
      )
    )
  }

  private publishEvidence(evidence: AgentChildWorkEvidence[]): void {
    try {
      this.deps.onChildWorkEvidence?.(evidence)
    } catch (error) {
      try {
        this.deps.onChildWorkFailure?.(error)
      } catch {
        // Diagnostics cannot fail an admitted journal transition.
      }
    }
  }

  private publishSessionEnd(): void {
    this.publishEvidence([{ type: 'session-ended', observedAt: this.deps.now?.() ?? Date.now() }])
  }

  private notifyTurnWatchers(): void {
    for (const check of this.turnWatchers) {
      check()
    }
  }

  private reportTextDrop(drop: AcpTextDrop): void {
    this.logger.warn('ACP text chunk rejected by its message stream', {
      scope: `acp-text-${drop.reason}`,
      sessionId: this.deps.sessionId,
      providerSessionId: this.deps.providerSessionId,
      agent: this.deps.agent,
      generation: this.deps.generation,
      ...drop
    })
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}

export function acpLaneChildWorkDelivery(
  deps: AcpStructuredSessionAdapterDeps,
  sessionId: string,
  producer?: StructuredAgentSessionChildWorkProducer
): Pick<AcpStructuredLaneDeps, 'onChildWorkEvidence' | 'onChildWorkFailure'> {
  return {
    onChildWorkEvidence: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence, producer),
    onChildWorkFailure: (error) =>
      deps.logger?.error('publishing ACP child work failed', {
        scope: 'acp-child-work',
        sessionId,
        error
      })
  }
}
