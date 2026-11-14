import type { IpcMainEvent, WebContents } from 'electron'
import type { AiVaultRowsEvent, AiVaultScanRows } from '../../shared/ai-vault-scan-rows'
import { aiVaultSessionListCacheGeneration } from '../ai-vault/listing/cached-session-list'
import { SessionRowPublisher } from '../ai-vault/session-row-publisher'
import { setRowInterest } from '../ai-vault/scan-lifecycle/ai-vault-row-interest'
import {
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSessions
} from '../ai-vault/structured-sessions/structured-session-ownership'

const deliveries = new Map<WebContents, Map<string, AiVaultRowDelivery>>()

/** Request-local delivery; the scan owner retains the current view for late subscribers. */
export class AiVaultRowDelivery {
  private publisher: SessionRowPublisher | null = null
  private scanId: string | null = null
  private sequence = 0
  private acknowledge: (() => void) | null = null
  private closed = false
  private readonly interestListeners = new Set<() => void>()
  private readonly generation: number | undefined

  constructor(
    private readonly sender: WebContents,
    private readonly requestToken: string,
    private readonly signal?: AbortSignal,
    includesLocal = true
  ) {
    this.generation = includesLocal ? aiVaultSessionListCacheGeneration() : undefined
    setRowInterest(this.observe, {
      observed: () => !this.closed,
      subscribe: (changed) => {
        this.interestListeners.add(changed)
        return () => this.interestListeners.delete(changed)
      }
    })
    const requests = deliveries.get(sender) ?? new Map<string, AiVaultRowDelivery>()
    requests.get(requestToken)?.dispose()
    requests.set(requestToken, this)
    deliveries.set(sender, requests)
    signal?.addEventListener('abort', this.dispose, { once: true })
    sender.once('destroyed', this.dispose)
  }

  readonly observe = (view: AiVaultScanRows): void => {
    if (!this.isCurrent()) {
      return
    }
    if (this.scanId !== view.scanId) {
      this.acknowledge?.()
      void this.publisher?.finish()
      this.scanId = view.scanId
      let reset = true
      this.publisher = new SessionRowPublisher(
        async (delta) => {
          if (!this.isCurrent() || this.scanId !== view.scanId) {
            return
          }
          const event: AiVaultRowsEvent = {
            ...delta,
            requestToken: this.requestToken,
            scanId: view.scanId,
            sequence: ++this.sequence,
            reset
          }
          reset = false
          await new Promise<void>((resolve) => {
            // A detached renderer retires only preview delivery, never the scan's final response.
            const timer = setTimeout(() => {
              this.dispose()
              resolve()
            }, 5_000)
            this.acknowledge = () => {
              clearTimeout(timer)
              this.acknowledge = null
              resolve()
            }
            this.sender.send('aiVault:rows', event)
          })
        },
        (rows) =>
          projectStructuredAiVaultSessions(
            { sessions: rows, issues: [], scannedAt: '' },
            OPENS_EVERY_STRUCTURED_CHAT
          ).sessions
      )
    }
    this.publisher?.observe(
      view.kind === 'snapshot' ? { upserts: [...view.sessions], removed: [] } : view.delta
    )
  }

  ack(sequence: number): void {
    if (sequence === this.sequence) {
      this.acknowledge?.()
    }
  }

  readonly dispose = (): void => {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const changed of this.interestListeners) {
      changed()
    }
    this.interestListeners.clear()
    this.acknowledge?.()
    void this.publisher?.finish()
    this.signal?.removeEventListener('abort', this.dispose)
    this.sender.removeListener('destroyed', this.dispose)
    const requests = deliveries.get(this.sender)
    if (requests?.get(this.requestToken) === this) {
      requests.delete(this.requestToken)
    }
    if (requests?.size === 0) {
      deliveries.delete(this.sender)
    }
  }

  private isCurrent(): boolean {
    if (this.closed) {
      return false
    }
    if (
      this.sender.isDestroyed() ||
      this.signal?.aborted ||
      (this.generation !== undefined && this.generation !== aiVaultSessionListCacheGeneration())
    ) {
      this.dispose()
      return false
    }
    return true
  }
}

export function acknowledgeAiVaultRows(
  event: IpcMainEvent,
  args: { requestToken?: string; sequence?: number } | undefined
): void {
  if (typeof args?.requestToken !== 'string' || typeof args.sequence !== 'number') {
    return
  }
  deliveries.get(event.sender)?.get(args.requestToken)?.ack(args.sequence)
}
