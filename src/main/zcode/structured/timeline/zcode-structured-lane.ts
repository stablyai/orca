import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../../../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineSink } from '../../../native-chat/agent-session-timeline/provider-timeline-plan'
import type { ProviderTimelineEvent } from '../../../native-chat/agent-session-timeline/provider-timeline-event'
import type { StructuredAgentSessionCommandRun } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  neverThrowingStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { ZcodeTimelineTranslator } from './zcode-timeline-translator'

const BACKPRESSURE_RETRY_MS = 250

// Preserve event order across journal backpressure; hold later events until the sink accepts.

export type ZcodeStructuredLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  generation: string
  providerSessionId: string
  logger: StructuredAgentSessionLogger
  /** First provider event confirms receipt of an Orca send. */
  onInputAccepted: (clientMessageId: string) => void
  /** Permanent sink refusal prevents further journaling. */
  onFailed: (reason: string) => void
  now?: () => number
}

export class ZcodeStructuredLane {
  readonly translator: ZcodeTimelineTranslator
  private readonly assembler: ProviderTimelineAssembler
  private readonly backlog: ProviderTimelineEvent[] = []
  private readonly turnWatchers = new Set<() => void>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private ended = false
  private disposed = false
  private readonly logger: StructuredAgentSessionLogger

  constructor(private readonly deps: ZcodeStructuredLaneDeps) {
    this.logger = neverThrowingStructuredAgentSessionLogger(deps.logger)
    this.translator = new ZcodeTimelineTranslator({ providerSessionId: deps.providerSessionId })
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

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    if (this.failed || this.disposed || this.backlog.length > 0) {
      throw new Error('zcode timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly ProviderTimelineEvent[]): void {
    if (this.failed || this.disposed) {
      return
    }
    this.backlog.push(...events)
    this.drain()
  }

  /** Resolves when the turn leaves or further writes become impossible. */
  whenTurnLeaves(turnId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (signal?.aborted || this.failed || this.disposed || this.openTurnId !== turnId) {
          this.turnWatchers.delete(check)
          signal?.removeEventListener('abort', check)
          resolve()
        }
      }
      this.turnWatchers.add(check)
      signal?.addEventListener('abort', check, { once: true })
      check()
    })
  }

  retry(): void {
    this.drain()
  }

  flush(): void {
    this.assembler.flush()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.clearRetry()
    this.backlog.length = 0
    this.assembler.dispose()
    this.notifyTurnWatchers()
  }

  private drain(): void {
    this.clearRetry()
    while (this.backlog.length > 0 && !this.failed && !this.disposed) {
      const event = this.backlog[0]!
      const { admission } = this.assembler.apply(event)
      if (!admission.accepted) {
        this.refused(admission.reason)
        return
      }
      this.backlog.shift()
      // Ignore live-child evidence after session end.
      this.ended ||= event.type === 'session.ended'
      if (event.type === 'input.accepted') {
        this.deps.onInputAccepted(event.clientMessageId)
      }
    }
    this.notifyTurnWatchers()
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
    this.logger.warn('zcode chat journal refused a write', {
      scope: 'zcode-timeline-refused',
      sessionId: this.deps.sessionId,
      reason
    })
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
