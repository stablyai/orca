// One ACP child's path into the journal: the translator turns its traffic into grammar events, and
// the shared assembler writes them. Events apply strictly in order; one the sink refuses under
// backpressure holds every later one until the sink drains, so nothing is reordered or dropped.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { AcpTimelineEvent } from './acp-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpChildStops, AcpDialect } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { acpSubagentChildWork, isAcpSubagentChildWorkEvent } from './acp-subagent-child-work'
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

/** How long a held event waits for the sink to say it drained before trying again on its own. */
const BACKPRESSURE_RETRY_MS = 250

export type AcpStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  /** The agent's name as a person reads it, for the rows that name it. */
  agentName: string
  generation: string
  providerSessionId: string
  dialect: AcpDialect
  logger: StructuredAgentSessionLogger
  /** A send of Orca's reached the agent: the turn it opened has its first provider event. */
  onInputAccepted: (clientMessageId: string) => void
  /** The sink refused for good; nothing more this child says can be journaled. */
  onFailed: (reason: string) => void
  onChildWorkEvidence?: (evidence: AgentChildWorkEvidence[]) => void
  onChildWorkFailure?: (error: unknown) => void
  now?: () => number
  childStops?: () => AcpChildStops
}

export class AcpStructuredLane {
  readonly translator: AcpTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: AcpTimelineEvent[] = []
  private readonly turnWatchers = new Set<() => void>()
  private readonly requestIdentity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
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

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  /** The host already opened this command's turn; the agent's frames and end join that turn. */
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
    this.drain()
  }

  /** Resolves once `turnId` is no longer the open turn, or nothing more can be written. */
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

  /** The sink drained: whatever it held back goes now. */
  retry(): void {
    this.drain()
  }

  /** Whether the journal row `itemId` is the row of request `requestKey`, which the assembler
   *  writes under this acquisition's generation (any incarnation a reused key adds). */
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
      const { admission, dropped } = this.assembler.apply(
        event,
        isAcpSubagentChildWorkEvent(event) || isAcpBackgroundTaskChildWorkEvent(event)
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
        if (admission.reason === 'backpressure') {
          this.retryTimer = setTimeout(() => this.drain(), BACKPRESSURE_RETRY_MS)
          return
        }
        this.failed = true
        this.backlog.length = 0
        this.notifyTurnWatchers()
        this.deps.onFailed(admission.reason)
        return
      }
      this.backlog.shift()
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
    this.notifyTurnWatchers()
  }

  private publishChildWork(event: AcpTimelineEvent): void {
    const observedAt = this.deps.now?.() ?? Date.now()
    const stops = this.deps.childStops?.()
    const evidence = [
      ...acpSubagentChildWork(event, observedAt, stops?.subagents === true),
      ...acpBackgroundTaskChildWork(event, observedAt, stops?.backgroundTasks === true)
    ]
    if (!evidence.length) {
      return
    }
    this.publishEvidence(evidence)
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
  sessionId: string
): Pick<AcpStructuredLaneDeps, 'onChildWorkEvidence' | 'onChildWorkFailure'> {
  return {
    onChildWorkEvidence: (evidence) => deps.onChildWorkEvidence?.(sessionId, evidence),
    onChildWorkFailure: (error) =>
      deps.logger?.error('publishing ACP child work failed', {
        scope: 'acp-child-work',
        sessionId,
        error
      })
  }
}
