import type { SessionSearchInputReceipt } from './session-search-catalog-types'
import type { WatcherProcessEvent } from '../ipc/filesystem/watcher-process/parcel-watcher-process-protocol'

type Notice = {
  identity: string
  failed: boolean
  events: Map<string, WatcherProcessEvent>
  reconcile: boolean
  recovery: boolean
}
export type SessionSearchRootWatch = Notice & {
  receipt: (phase: string) => SessionSearchInputReceipt
  eventReceipt: (path: string) => SessionSearchInputReceipt
  acknowledgeEvent: (path: string) => void
  acknowledge: () => void
}

/** Each consumer retains one unaccepted delivery beside coalesced later arrivals. */
export class SessionSearchWatchDelivery {
  private events = new Map<string, WatcherProcessEvent>()
  private reconcile = false
  private recovery = false
  private active: SessionSearchRootWatch | undefined
  private identity = ''
  private failed = false
  constructor(
    private readonly consumer: string,
    private readonly next: () => number
  ) {}
  get pending(): boolean {
    return !!this.active || this.events.size > 0 || this.reconcile || this.recovery
  }
  stage(notice: Notice): void {
    if (this.identity && this.identity !== notice.identity) {
      this.reconcile = true
      this.recovery = true
    }
    this.identity = notice.identity
    this.failed = notice.failed
    this.reconcile ||= notice.reconcile
    this.recovery ||= notice.recovery
    for (const [path, event] of notice.events) {
      if (this.events.size >= 16_384 && !this.events.has(path)) {
        this.reconcile = true
        this.recovery = true
        break
      }
      this.events.set(path, event)
    }
  }
  capture(): SessionSearchRootWatch {
    if (this.active) {
      return this.active
    }
    const revision = this.next()
    const events = this.events
    const receipts = new Map([...events.keys()].map((path) => [path, this.next()]))
    this.events = new Map()
    const active: SessionSearchRootWatch = {
      identity: this.identity,
      failed: this.failed,
      events,
      reconcile: this.reconcile,
      recovery: this.recovery,
      receipt: (phase) => ({ consumer: `${this.consumer}:${phase}`, revision }),
      eventReceipt: (path) => ({
        consumer: `${this.consumer}:events`,
        revision: receipts.get(path)!
      }),
      acknowledgeEvent: (path) => {
        events.delete(path)
        receipts.delete(path)
      },
      acknowledge: () => {
        if (this.active === active) {
          this.active = undefined
        }
      }
    }
    this.reconcile = false
    this.recovery = false
    this.active = active
    return active
  }
}
