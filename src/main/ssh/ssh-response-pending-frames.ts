const MAX_PENDING_FRAMES = 64
const DEFAULT_PENDING_RESPONSE_BYTES = 64 * 1024 * 1024

export function boundedSshResponseDiagnostic(message: unknown, maxResponseBytes?: number): string {
  if (typeof message !== 'string') {
    return 'git response stream error'
  }
  return message.length * 2 <= Math.min(8192, maxResponseBytes ?? 8192)
    ? message
    : 'Filesystem response error exceeds the retention budget'
}

export type PendingResponseFrame = {
  kind: 'chunk' | 'end' | 'error'
  params: Record<string, unknown>
  encodedBytes: number
}

/** Holds only known scalar fields until the sentinel identifies the request's stream. */
export class SshResponsePendingFrames {
  private readonly frames: PendingResponseFrame[] = []
  private readonly droppedStreams = new Set<number>()
  private encodedBytes = 0
  private evidenceOverflow = false
  readonly maxEncodedBytes: number
  private readonly maxDiagnosticBytes: number

  constructor(maxResponseBytes = DEFAULT_PENDING_RESPONSE_BYTES) {
    this.maxDiagnosticBytes = Math.min(8192, maxResponseBytes)
    // Each chunk pads independently; allow bounded padding as well as two-byte code units.
    this.maxEncodedBytes =
      Math.ceil(maxResponseBytes / 3) * 8 + (maxResponseBytes > 0 ? MAX_PENDING_FRAMES * 8 : 0)
  }

  private recordDrop(streamId: number): void {
    if (this.droppedStreams.size < MAX_PENDING_FRAMES) {
      this.droppedStreams.add(streamId)
    } else if (!this.droppedStreams.has(streamId)) {
      this.evidenceOverflow = true
    }
  }

  push(kind: PendingResponseFrame['kind'], source: Record<string, unknown>): void {
    const streamId = source.streamId
    if (typeof streamId !== 'number' || !Number.isSafeInteger(streamId) || streamId < 0) {
      return
    }
    const text = kind === 'chunk' ? source.data : kind === 'error' ? source.message : undefined
    const encodedBytes = typeof text === 'string' ? text.length * 2 : 0
    if (
      encodedBytes > this.maxEncodedBytes ||
      (kind === 'error' && encodedBytes > this.maxDiagnosticBytes)
    ) {
      this.recordDrop(streamId)
      return
    }
    while (
      this.frames.length > 0 &&
      (this.frames.length >= MAX_PENDING_FRAMES ||
        this.encodedBytes + encodedBytes > this.maxEncodedBytes)
    ) {
      const discarded = this.shift()!
      const discardedId = discarded.params.streamId
      if (typeof discardedId === 'number') {
        this.recordDrop(discardedId)
      }
    }
    const params: Record<string, unknown> = { streamId }
    if (kind === 'chunk') {
      params.seq = typeof source.seq === 'number' ? source.seq : undefined
      params.data = typeof text === 'string' ? text : undefined
    } else if (kind === 'error') {
      params.message = typeof text === 'string' ? text : undefined
    }
    this.frames.push({ kind, params, encodedBytes })
    this.encodedBytes += encodedBytes
  }

  lostFrames(streamId: number): boolean {
    return this.evidenceOverflow || this.droppedStreams.has(streamId)
  }

  shift(): PendingResponseFrame | undefined {
    const frame = this.frames.shift()
    if (frame) {
      this.encodedBytes -= frame.encodedBytes
    }
    return frame
  }

  clear(): void {
    this.frames.length = 0
    this.droppedStreams.clear()
    this.encodedBytes = 0
    this.evidenceOverflow = false
  }

  get retainedBytes(): number {
    return this.encodedBytes
  }
}
