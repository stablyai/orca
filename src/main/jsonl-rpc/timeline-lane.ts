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
  private readonly held: {
    events: { event: ProviderTimelineEvent; bytes: number }[]
    bytes: number
  }[] = []
  private heldEvents = 0
  private sealed = false
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
    if (this.ended || this.sealed || this.held.length > 0) {
      throw new Error('Provider timeline has not drained for this command')
    }
    this.assembler.beginCommand(command)
  }

  forgetCommand(turnId: string): void {
    this.assembler.forgetCommand(turnId)
  }

  apply(events: readonly ProviderTimelineEvent[]): void {
    if (this.ended || this.sealed) {
      return
    }
    const pending = events.map((event) => ({
      event,
      bytes: Buffer.byteLength(JSON.stringify(event))
    }))
    // Try the current frame first; only a refused suffix becomes retained head work.
    while (this.held.length === 0 && pending.length > 0 && !this.ended) {
      if (!this.consume(pending[0].event)) {
        break
      }
      pending.shift()
    }
    this.notify()
    if (pending.length === 0 || this.ended) {
      return
    }
    const bytes = pending.reduce((total, entry) => total + entry.bytes, 0)
    if (
      this.heldEvents + pending.length > MAX_HELD_EVENTS ||
      (this.held.length > 0 && this.heldBytes - this.held[0].bytes + bytes > MAX_HELD_BYTES)
    ) {
      this.fail('Agent timeline queue capacity exceeded')
      return
    }
    this.held.push({ events: pending, bytes })
    this.heldEvents += pending.length
    this.heldBytes += bytes
    this.retry()
  }

  private consume(event: ProviderTimelineEvent): boolean {
    const result = this.assembler.apply(event)
    if (!result.admission.accepted) {
      if (result.admission.reason !== 'backpressure') {
        this.fail(result.admission.reason)
      }
      return false
    }
    if (event.type === 'input.accepted' && !result.dropped) {
      this.deps.onInputAccepted(event.clientMessageId)
    }
    return true
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
        const batch = this.held[0]
        const entry = batch.events[0]
        if (!this.consume(entry.event)) {
          if (!this.ended) {
            this.deps.pauseReading()
            this.retryTimer = setTimeout(() => this.retry(), 250)
            this.retryTimer.unref()
          }
          return
        }
        batch.events.shift()
        batch.bytes -= entry.bytes
        this.heldBytes -= entry.bytes
        this.heldEvents -= 1
        if (batch.events.length === 0) {
          this.held.shift()
        }
      }
    } finally {
      this.draining = false
      this.notify()
    }
    if (!this.sealed && !this.ended) {
      this.deps.resumeReading()
    }
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

  finalize(end?: Extract<ProviderTimelineEvent, { type: 'session.ended' }>): void {
    if (this.sealed || this.ended) {
      return
    }
    // At most 256 held events + 128 dirty streams + this internal end: below 512 tail slots.
    this.sealed = true
    this.finalizing = true
    this.retry()
    if (this.ended) {
      return
    }
    if (this.held.length > 0 || (end && !this.consume(end))) {
      this.fail('Agent final timeline could not be transferred')
      return
    }
    this.flush()
    this.assembler.dispose()
  }

  dispose(): void {
    this.ended = true
    clearTimeout(this.retryTimer)
    this.held.length = 0
    this.heldBytes = 0
    this.heldEvents = 0
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
