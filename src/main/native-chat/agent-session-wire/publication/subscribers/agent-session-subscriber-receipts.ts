import { randomUUID } from 'node:crypto'
import type {
  AgentSessionProviderReceiptFrame,
  ProviderReceiptUpdate
} from '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-provider-receipts'

export type ProviderReceiptEmitter = (
  frame: AgentSessionProviderReceiptFrame,
  signal: AbortSignal
) => void | Promise<void>

export const MAX_PROVIDER_RECEIPT_STREAMS = 256
// At most one 256-key frame and one 256-key accumulator per stream. Keys are at most 128 UTF-16
// code units. Counting JSON's worst-case escaping and metadata, each frame is under 224 KiB.
export const MAX_PROVIDER_RECEIPT_FRAME_ENTRIES = 256
export const MAX_PROVIDER_RECEIPT_KEY_LENGTH = 128
export const MAX_PROVIDER_RECEIPT_FRAME_BYTES = 224 * 1024

/** Separate from structural delivery. A slow transport can retain one current frame and one update. */
export class AgentSessionReceiptStream {
  private readonly subscription = randomUUID()
  private readonly stop = new AbortController()
  private readonly pending = new Map<string, number | null>()
  private replace = true
  private opened = false
  private busy = false

  constructor(
    private readonly sessionId: string,
    private readonly incarnation: string,
    private emit: ProviderReceiptEmitter | undefined,
    private read: (() => { revision: number; snapshot: () => ProviderReceiptUpdate[] }) | undefined
  ) {}

  open(): void {
    this.opened = true
    this.schedule()
  }

  changed(clientMessageId: string, observedAt: number | null): void {
    if (!this.replace) {
      if (
        this.pending.size === MAX_PROVIDER_RECEIPT_FRAME_ENTRIES &&
        !this.pending.has(clientMessageId)
      ) {
        this.reset()
        return
      }
      this.pending.set(clientMessageId, observedAt)
    }
    this.schedule()
  }

  reset(): void {
    this.pending.clear()
    this.replace = true
    this.schedule()
  }

  close(): void {
    this.emit = undefined
    this.read = undefined
    this.pending.clear()
    this.stop.abort()
  }

  private schedule(): void {
    if (!this.opened || this.busy || !this.emit) {
      return
    }
    this.busy = true
    queueMicrotask(() => this.deliver())
  }

  private deliver(): void {
    const emit = this.emit
    if (!emit || (!this.replace && this.pending.size === 0)) {
      this.busy = false
      return
    }
    try {
      const state = this.read!()
      const replace = this.replace
      const updates = replace
        ? state.snapshot()
        : Array.from(this.pending, ([clientMessageId, observedAt]) => ({
            clientMessageId,
            observedAt
          }))
      this.pending.clear()
      this.replace = false
      void Promise.resolve(
        emit(
          {
            type: 'provider-receipts',
            sessionId: this.sessionId,
            hostIncarnation: this.incarnation,
            subscription: this.subscription,
            revision: state.revision,
            replace,
            updates
          },
          this.stop.signal
        )
      ).then(this.delivered, this.failed)
    } catch {
      this.failed()
    }
  }

  private delivered = (): void => {
    this.busy = false
    if (this.replace || this.pending.size > 0) {
      this.schedule()
    }
  }

  private failed = (): void => {
    this.busy = false
    // Retry only when newer state is available. A failed send may have reached the other end.
    const newer = this.replace || this.pending.size > 0
    this.pending.clear()
    this.replace = true
    if (newer) {
      this.schedule()
    }
  }
}
