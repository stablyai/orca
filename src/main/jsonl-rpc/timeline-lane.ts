import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler
} from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type JsonlRpcTimelineLaneDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: string
  generation: string
  namespace: string
  onInputAccepted: (clientMessageId: string) => void
  onFailed: (reason: string) => void
}

/** A dialect supplies semantic events; the shared assembler owns every journal write. */
export class JsonlRpcTimelineLane {
  private readonly assembler: ProviderTimelineAssembler
  private readonly identity: ReturnType<typeof createLegacyProviderTimelineIdentityScheme>
  private readonly pending: ProviderTimelineEvent[] = []
  private sealed = false
  private draining = false
  private ended = false
  private readonly watchers = new Set<() => void>()

  constructor(private readonly deps: JsonlRpcTimelineLaneDeps) {
    this.assembler = createProviderTimelineAssembler(deps)
    this.identity = createLegacyProviderTimelineIdentityScheme(deps)
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    this.retry()
    if (this.ended || this.sealed || this.pending.length > 0) {
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
    this.pending.push(...events)
    this.retry()
  }

  private consume(event: ProviderTimelineEvent): boolean {
    const result = this.assembler.apply(event)
    if (!result.admission.accepted) {
      this.fail(result.admission.reason)
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
    this.draining = true
    try {
      while (this.pending.length > 0 && !this.ended) {
        const event = this.pending.shift()
        if (event && !this.consume(event)) {
          return
        }
      }
    } finally {
      this.draining = false
      this.notify()
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
        if (this.ended || this.pending.length === 0) {
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
    this.sealed = true
    this.retry()
    if (this.ended) {
      return
    }
    if (this.pending.length > 0 || (end && !this.consume(end))) {
      this.fail('Agent final timeline could not be transferred')
      return
    }
    this.flush()
    this.assembler.dispose()
  }

  dispose(): void {
    this.ended = true
    this.pending.length = 0
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
