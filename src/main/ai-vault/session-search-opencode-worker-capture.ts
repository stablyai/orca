import type { SessionSearchCapturedMessage } from './session-search-capture'
import type { OpenCodeSqliteCaptureBatch } from './session-scanner-opencode-sqlite-worker-protocol'

export const OPENCODE_CAPTURE_BATCH_CHARS = 256 * 1024
export const OPENCODE_CAPTURE_BATCH_MESSAGES = 128

/** One acknowledged batch in flight; a single capped part may cross the threshold. */
export class OpenCodeWorkerSearchCapture {
  private messages: SessionSearchCapturedMessage[] = []
  private chars = 0
  private sequence = 0
  private acknowledgeBatch: (() => void) | null = null

  constructor(
    private readonly id: number,
    private readonly send: (batch: OpenCodeSqliteCaptureBatch) => void
  ) {}

  push(message: SessionSearchCapturedMessage): void {
    this.messages.push(message)
    this.chars += message.text.length
  }

  checkpoint(): Promise<void> {
    return this.chars >= OPENCODE_CAPTURE_BATCH_CHARS ||
      this.messages.length >= OPENCODE_CAPTURE_BATCH_MESSAGES
      ? this.flush()
      : Promise.resolve()
  }

  async flush(): Promise<void> {
    if (!this.messages.length) {
      return
    }
    const messages = this.messages
    this.messages = []
    this.chars = 0
    const sequence = ++this.sequence
    try {
      await new Promise<void>((resolve) => {
        this.acknowledgeBatch = resolve
        this.send({ id: this.id, kind: 'batch', batch: sequence, messages })
      })
    } finally {
      this.acknowledgeBatch = null
    }
  }

  acknowledge(sequence: number): void {
    if (sequence === this.sequence) {
      this.acknowledgeBatch?.()
    }
  }
}
