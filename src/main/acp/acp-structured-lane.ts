// One ACP child's path into the journal: the translator turns its traffic into grammar events, and
// the shared assembler writes them. Events apply strictly in order; one the sink refuses under
// backpressure holds every later one until the sink drains, so nothing is reordered or dropped.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

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
  /** A send of Orca's reached the agent: the turn it opened has its first provider event. */
  onInputAccepted: (clientMessageId: string) => void
  /** The sink refused for good; nothing more this child says can be journaled. */
  onFailed: (reason: string) => void
}

export class AcpStructuredLane {
  readonly translator: AcpTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: ProviderTimelineEvent[] = []
  private readonly turnWatchers = new Set<() => void>()
  private readonly requestIdentity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private disposed = false

  constructor(private readonly deps: AcpStructuredLaneDeps) {
    this.translator = new AcpTimelineTranslator({
      sessionId: deps.providerSessionId,
      dialect: deps.dialect,
      agentName: deps.agentName
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

  apply(events: readonly ProviderTimelineEvent[]): void {
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
    this.disposed = true
    this.clearRetry()
    this.backlog.length = 0
    this.assembler.dispose()
    this.notifyTurnWatchers()
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]
      const { admission } = this.assembler.apply(event)
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

  private notifyTurnWatchers(): void {
    for (const check of this.turnWatchers) {
      check()
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
