import { randomUUID } from 'node:crypto'
import {
  HerdrRuntimeError,
  type HerdrEventSubscription,
  type HerdrResponse,
  type HerdrSequencedEvent
} from './herdr-runtime-contract'

const LIFECYCLE_EVENTS = [
  'workspace.created',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.renamed',
  'workspace.moved',
  'workspace.closed',
  'workspace.focused',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated'
] as const

export function herdrEventsSubscribeRequest(afterSequence: number): string {
  return `${JSON.stringify({
    id: randomUUID(),
    method: 'events.subscribe',
    params: {
      after_sequence: afterSequence,
      subscriptions: LIFECYCLE_EVENTS.map((type) => ({ type }))
    }
  })}\n`
}

export class HerdrEventSubscriptionBuffer implements HerdrEventSubscription {
  private readonly eventListeners = new Set<(event: HerdrSequencedEvent) => void>()
  private readonly errorListeners = new Set<(error: HerdrRuntimeError) => void>()
  private readonly pendingEvents: HerdrSequencedEvent[] = []
  private pendingError: HerdrRuntimeError | null = null
  private released = false

  constructor(private readonly releaseTransport: () => void) {}

  acceptLine(line: string): void {
    if (this.released) return
    const value = JSON.parse(line) as
      | HerdrResponse<{ type: 'subscription_started'; sequence: number }>
      | HerdrSequencedEvent
    if ('error' in value) {
      this.fail(new HerdrRuntimeError(value.error.code, value.error.message))
      return
    }
    if ('result' in value) return
    if (typeof value.sequence !== 'number' || typeof value.event !== 'string') {
      this.fail(new HerdrRuntimeError('invalid_event', 'Herdr returned an invalid event envelope'))
      return
    }
    if (this.eventListeners.size === 0) this.pendingEvents.push(value)
    else for (const listener of this.eventListeners) listener(value)
  }

  fail(error: unknown): void {
    if (this.released) return
    const runtimeError =
      error instanceof HerdrRuntimeError
        ? error
        : new HerdrRuntimeError(
            'transport_error',
            error instanceof Error ? error.message : String(error)
          )
    if (this.errorListeners.size === 0) this.pendingError = runtimeError
    else for (const listener of this.errorListeners) listener(runtimeError)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.releaseTransport()
    this.pendingEvents.length = 0
    this.pendingError = null
    this.eventListeners.clear()
    this.errorListeners.clear()
  }

  onEvent(listener: (event: HerdrSequencedEvent) => void): () => void {
    this.eventListeners.add(listener)
    for (const event of this.pendingEvents.splice(0)) listener(event)
    return () => this.eventListeners.delete(listener)
  }

  onError(listener: (error: HerdrRuntimeError) => void): () => void {
    this.errorListeners.add(listener)
    if (this.pendingError) {
      listener(this.pendingError)
      this.pendingError = null
    }
    return () => this.errorListeners.delete(listener)
  }
}
