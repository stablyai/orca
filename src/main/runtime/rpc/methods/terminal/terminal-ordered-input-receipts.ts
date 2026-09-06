import {
  TERMINAL_ORDERED_INPUT_CAPABILITY,
  type TerminalInputReceipt
} from '../../../../../shared/terminal-ordered-input'

type InputLimits = { maxFrameBytes: number; maxPendingBytes: number; maxPendingFrames: number }
type WriteResult = Omit<TerminalInputReceipt, 'sequence'>

export class TerminalOrderedInputReceipts {
  private nextSequence = 1
  private failedAt = Infinity
  private pendingBytes = 0
  private pendingFrames = 0

  constructor(
    private readonly options: {
      isClosed: () => boolean
      close: () => void
      receipt: (receipt: TerminalInputReceipt) => void
      enqueue: (codeUnits: number, run: () => Promise<WriteResult>) => Promise<WriteResult>
      write: (text: string) => Promise<WriteResult>
      limits?: InputLimits
    }
  ) {}

  receive(sequence: number, payload: Uint8Array): void {
    if (this.options.isClosed()) {
      return
    }
    if (!Number.isSafeInteger(sequence) || sequence !== this.nextSequence) {
      this.publish({ sequence, outcome: 'rejected', reason: 'invalid_sequence' })
      this.options.close()
      return
    }
    this.nextSequence++
    if (sequence >= this.failedAt) {
      this.publish({ sequence, outcome: 'rejected', reason: 'dependency_failed' })
      return
    }
    const limits = this.options.limits ?? TERMINAL_ORDERED_INPUT_CAPABILITY
    if (payload.byteLength > limits.maxFrameBytes) {
      this.failedAt = sequence
      this.publish({ sequence, outcome: 'rejected', reason: 'too_large' })
      return
    }
    if (
      this.pendingFrames >= limits.maxPendingFrames ||
      this.pendingBytes + payload.byteLength > limits.maxPendingBytes
    ) {
      this.failedAt = sequence
      this.publish({ sequence, outcome: 'rejected', reason: 'queue_full' })
      return
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload)
    } catch {
      this.failedAt = sequence
      this.publish({ sequence, outcome: 'rejected', reason: 'invalid_payload' })
      return
    }
    this.pendingFrames++
    this.pendingBytes += payload.byteLength
    // Admission happens before any await, including viewport and input validation.
    void this.options
      .enqueue(text.length, async () => {
        if (this.options.isClosed() || sequence >= this.failedAt) {
          return { outcome: 'rejected', reason: 'dependency_failed' }
        }
        const result = await this.options.write(text).catch((): WriteResult => ({
          outcome: 'unknown',
          reason: 'write_failed'
        }))
        if (result.outcome !== 'accepted') {
          this.failedAt = Math.min(this.failedAt, sequence)
        }
        return result
      })
      .catch((error: unknown): WriteResult => {
        this.failedAt = Math.min(this.failedAt, sequence)
        const message = error instanceof Error ? error.message : String(error)
        return {
          outcome: 'rejected',
          reason: message.includes('queue') ? 'queue_full' : 'stale'
        }
      })
      .then((result) => {
        this.pendingFrames--
        this.pendingBytes -= payload.byteLength
        this.publish({ sequence, ...result })
      })
  }

  private publish(receipt: TerminalInputReceipt): void {
    if (!this.options.isClosed()) {
      this.options.receipt(receipt)
    }
  }
}
