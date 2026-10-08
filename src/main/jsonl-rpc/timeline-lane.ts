import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

const MAX_HELD_EVENTS = 256
const MAX_HELD_BYTES = 4 * 1024 * 1024

export type JsonlRpcTimelineLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  generation: string
  namespace: string
  pauseReading: () => void
  resumeReading: () => void
  onInputAccepted: (clientMessageId: string) => void
  onFailed: (reason: string) => void
}

/** A dialect supplies semantic events; the shared assembler owns every journal write. */
export class JsonlRpcTimelineLane {
  private readonly assembler: ProviderTimelineAssembler
  private readonly identity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private readonly held: { event: ProviderTimelineEvent; bytes: number }[] = []
  private heldBytes = 0
  private draining = false
  private ended = false
  private finalizing = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private readonly watchers = new Set<() => void>()

  constructor(private readonly deps: JsonlRpcTimelineLaneDeps) {
    this.assembler = createProviderTimelineAssembler({
      ...deps,
      sink: {
        ...deps.sink,
        tryAppendTransition: (transition) =>
          deps.sink.tryAppendTransition(
            this.finalizing ? { ...transition, lifecycle: true, finalTail: true } : transition
          )
      }
    })
    this.identity = createLegacyProviderTimelineIdentityScheme(deps)
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    this.retry()
    if (this.ended || this.held.length > 0) {
      throw new Error('Provider timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly ProviderTimelineEvent[]): void {
    if (this.ended) {
      return
    }
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event))
      if (this.held.length >= MAX_HELD_EVENTS || this.heldBytes + bytes > MAX_HELD_BYTES) {
        this.fail('Agent timeline queue capacity exceeded')
        return
      }
      this.held.push({ event, bytes })
      this.heldBytes += bytes
      this.retry()
    }
  }

  retry(): void {
    if (this.draining || this.ended) {
      return
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.draining = true
    try {
      while (this.held.length > 0 && !this.ended) {
        const entry = this.held[0]
        const result = this.assembler.apply(entry.event)
        if (!result.admission.accepted) {
          if (result.admission.reason !== 'backpressure') {
            this.fail(result.admission.reason)
          } else {
            this.deps.pauseReading()
            this.retryTimer = setTimeout(() => this.retry(), 250)
            this.retryTimer.unref()
          }
          return
        }
        this.held.shift()
        this.heldBytes -= entry.bytes
        if (entry.event.type === 'input.accepted' && !result.dropped) {
          this.deps.onInputAccepted(entry.event.clientMessageId)
        }
      }
    } finally {
      this.draining = false
      this.notify()
    }
    this.deps.resumeReading()
  }

  whenTurnLeaves(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.ended || this.openTurnId !== turnId) {
          this.watchers.delete(check)
          resolve()
        }
      }
      this.watchers.add(check)
      check()
    })
  }

  drained(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.ended || this.held.length === 0) {
          this.watchers.delete(check)
          resolve()
        }
      }
      this.watchers.add(check)
      check()
    })
  }

  isRequestRow(itemId: string, key: string): boolean {
    const row = parseAgentJournalItemKey(itemId)
    const expected = this.identity.request({
      generation: this.deps.generation,
      key,
      incarnation: 1
    })
    return (
      row?.provider === 'legacy' &&
      expected.provider === 'legacy' &&
      row.agent === this.deps.agent &&
      row.sessionId === this.deps.sessionId &&
      (row.recordId === expected.recordId || row.recordId.startsWith(`${expected.recordId}#`))
    )
  }

  flush(): void {
    this.assembler.flush()
  }

  finalize(): void {
    // Admission must precede the host's exit barrier even when lifecycle writes are full.
    this.finalizing = true
    this.retry()
    this.flush()
  }

  dispose(): void {
    this.ended = true
    clearTimeout(this.retryTimer)
    this.held.length = 0
    this.heldBytes = 0
    this.assembler.dispose()
    this.notify()
  }

  private fail(reason: string): void {
    this.dispose()
    this.deps.onFailed(reason)
  }

  private notify(): void {
    for (const check of this.watchers) {
      check()
    }
  }
}
