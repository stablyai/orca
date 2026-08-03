import type { WebContents } from 'electron'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import type { TerminalPreviewDataPayload } from '../../shared/terminal-preview'

const OUTPUT_BATCH_MS = 5
export const TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES = 64 * 1024
const OUTPUT_IN_FLIGHT_MAX_BYTES = 512 * 1024
const OUTPUT_PENDING_MAX_BYTES = 256 * 1024
const INITIAL_PENDING_MAX_BYTES = 256 * 1024

export type TerminalPreviewOutputMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
}

type PendingOutput = { data: string; bytes: number; meta?: TerminalPreviewOutputMeta }

function outputAfterSnapshotSeq(output: PendingOutput, snapshotSeq?: number): string | null {
  if (
    typeof snapshotSeq !== 'number' ||
    typeof output.meta?.seq !== 'number' ||
    typeof output.meta.rawLength !== 'number'
  ) {
    return output.data
  }
  if (output.meta.seq <= snapshotSeq) {
    return null
  }
  const startSeq = output.meta.seq - output.meta.rawLength
  if (startSeq >= snapshotSeq || output.meta.transformed === true) {
    return output.data
  }
  return output.data.slice(snapshotSeq - startSeq)
}

/** Owns one preview's bounded snapshot/live output queue and acknowledgements. */
export class TerminalPreviewOutputStream {
  private bufferingSnapshot = true
  private initialPending: PendingOutput[] = []
  private initialPendingBytes = 0
  private initialPendingOverflowed = false
  private batchChunks: string[] = []
  private batchBytes = 0
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private inFlightBytes = 0
  private pendingBatches: { data: string; bytes: number }[] = []
  private pendingBatchBytes = 0
  private resyncPending = false
  private awaitingReconnect = false
  private unsubscribeData: () => void = () => {}
  private isDisposed = false

  constructor(
    readonly contents: WebContents,
    readonly ptyId: string,
    private readonly releaseRawView: () => void,
    private readonly onDispose: (stream: TerminalPreviewOutputStream) => void
  ) {}

  get disposed(): boolean {
    return this.isDisposed
  }

  setDataSubscription(unsubscribe: () => void): void {
    this.unsubscribeData = unsubscribe
  }

  dispose(): void {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.unsubscribeData()
    this.releaseRawView()
    this.onDispose(this)
  }

  append(data: string, meta?: TerminalPreviewOutputMeta): void {
    if (this.isDisposed || this.awaitingReconnect || this.resyncPending) {
      return
    }
    if (this.bufferingSnapshot) {
      this.appendInitial(data, meta)
    } else {
      this.appendLive(data)
    }
  }

  consumeInitialOverflow(): boolean {
    if (!this.initialPendingOverflowed) {
      return false
    }
    this.initialPending = []
    this.initialPendingBytes = 0
    this.initialPendingOverflowed = false
    return true
  }

  completeSnapshot(snapshotSeq?: number): string[] {
    const replay = this.initialPending.flatMap((output) => {
      const uncovered = outputAfterSnapshotSeq(output, snapshotSeq)
      return uncovered ? [uncovered] : []
    })
    this.initialPending = []
    this.initialPendingBytes = 0
    this.bufferingSnapshot = false
    return replay
  }

  // Why: the PTY grid changed under this stream (viewer fit, host reclaim,
  // phone takeover) — buffered bytes were parsed for the old grid, so drop
  // them and hand the renderer a fresh authoritative snapshot instead.
  requestResync(): void {
    if (this.isDisposed || this.awaitingReconnect || this.resyncPending) {
      return
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.batchChunks = []
    this.batchBytes = 0
    this.pendingBatches = []
    this.pendingBatchBytes = 0
    this.resyncPending = true
    this.maybeDrain()
  }

  pauseForReconnect(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.batchChunks = []
    this.batchBytes = 0
    this.pendingBatches = []
    this.pendingBatchBytes = 0
    this.awaitingReconnect = true
  }

  acknowledge(bytes: number): void {
    this.inFlightBytes = Math.max(
      0,
      this.inFlightBytes - Math.min(this.inFlightBytes, Math.floor(bytes))
    )
    this.maybeDrain()
  }

  private send(payload: TerminalPreviewDataPayload): boolean {
    if (this.isDisposed || this.contents.isDestroyed()) {
      this.dispose()
      return false
    }
    try {
      this.contents.send('terminalPreview:data', payload)
      return true
    } catch {
      this.dispose()
      return false
    }
  }

  private maybeDrain(): void {
    if (this.isDisposed || this.awaitingReconnect) {
      return
    }
    if (this.resyncPending) {
      if (this.inFlightBytes === 0) {
        this.resyncPending = false
        this.awaitingReconnect = true
        this.send({ type: 'resync', ptyId: this.ptyId })
      }
      return
    }
    while (this.pendingBatches.length > 0) {
      const next = this.pendingBatches[0]!
      if (this.inFlightBytes > 0 && this.inFlightBytes + next.bytes > OUTPUT_IN_FLIGHT_MAX_BYTES) {
        break
      }
      this.pendingBatches.shift()
      this.pendingBatchBytes -= next.bytes
      if (this.send({ type: 'data', ptyId: this.ptyId, data: next.data, bytes: next.bytes })) {
        this.inFlightBytes += next.bytes
      }
    }
  }

  private queueBatch(data: string, bytes: number): void {
    if (this.isDisposed || this.awaitingReconnect || this.resyncPending) {
      return
    }
    if (
      this.pendingBatches.length === 0 &&
      (this.inFlightBytes === 0 || this.inFlightBytes + bytes <= OUTPUT_IN_FLIGHT_MAX_BYTES)
    ) {
      if (this.send({ type: 'data', ptyId: this.ptyId, data, bytes })) {
        this.inFlightBytes += bytes
      }
      return
    }
    this.pendingBatches.push({ data, bytes })
    this.pendingBatchBytes += bytes
    if (this.pendingBatchBytes > OUTPUT_PENDING_MAX_BYTES) {
      // Why: a stuck renderer heals from a fresh authoritative snapshot instead of retaining output without bound.
      this.pendingBatches = []
      this.pendingBatchBytes = 0
      this.resyncPending = true
    }
  }

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    if (this.batchChunks.length === 0) {
      return
    }
    const data = this.batchChunks.length === 1 ? this.batchChunks[0]! : this.batchChunks.join('')
    const bytes = this.batchBytes
    this.batchChunks = []
    this.batchBytes = 0
    this.queueBatch(data, bytes)
  }

  private appendLive(data: string): void {
    for (const chunk of iterateTerminalInputChunks(data, TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES)) {
      const bytes = Buffer.byteLength(chunk, 'utf8')
      if (
        this.batchBytes > 0 &&
        this.batchBytes + bytes > TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES
      ) {
        this.flushBatch()
      }
      this.batchChunks.push(chunk)
      this.batchBytes += bytes
      if (this.batchBytes >= TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES) {
        this.flushBatch()
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), OUTPUT_BATCH_MS)
        this.batchTimer.unref?.()
      }
    }
  }

  private appendInitial(data: string, meta?: TerminalPreviewOutputMeta): void {
    const bytes = Buffer.byteLength(data, 'utf8')
    this.initialPending.push({ data, bytes, meta })
    this.initialPendingBytes += bytes
    while (this.initialPendingBytes > INITIAL_PENDING_MAX_BYTES && this.initialPending.length > 0) {
      this.initialPendingBytes -= this.initialPending.shift()!.bytes
      this.initialPendingOverflowed = true
    }
  }
}
