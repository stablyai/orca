import type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
import { getOutputAfterSnapshotSeq } from './rpc/methods/terminal/terminal-stream-replay'

const TRAILING_OUTPUT_MAX_BYTES = 256 * 1024

export type TrailingTerminalOutputChunk = { data: string; seq: number }

/**
 * Live bytes published while a snapshot of the same PTY is being captured.
 * A snapshot taken one round-trip ago plus the bytes after its `seq` is the
 * only way to seed an emulator that is complete up to the live sequence.
 */
export class TrailingTerminalOutputCapture {
  private readonly chunks: { data: string; bytes: number; meta?: RuntimeTerminalDataMeta }[] = []
  private bytes = 0
  private overflowed = false

  /** `startSeq`: the PTY's output sequence when the capture began. */
  constructor(private readonly startSeq: number) {}

  push(data: string, meta?: RuntimeTerminalDataMeta): void {
    const bytes = Buffer.byteLength(data, 'utf8')
    this.chunks.push({ data, bytes, meta })
    this.bytes += bytes
    while (this.bytes > TRAILING_OUTPUT_MAX_BYTES && this.chunks.length > 0) {
      this.bytes -= this.chunks.shift()!.bytes
      this.overflowed = true
    }
  }

  /**
   * The bytes after `snapshotSeq`, or null when the capture cannot prove it
   * is contiguous with the snapshot — a snapshot older than the capture's
   * start, or a capture that overflowed, has a hole nothing here can fill.
   */
  after(snapshotSeq: number | undefined): TrailingTerminalOutputChunk[] | null {
    if (typeof snapshotSeq !== 'number' || snapshotSeq < this.startSeq || this.overflowed) {
      return null
    }
    const trailing: TrailingTerminalOutputChunk[] = []
    for (const chunk of this.chunks) {
      const seq = chunk.meta?.seq
      if (typeof seq !== 'number') {
        return null
      }
      const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotSeq)
      if (uncovered && uncovered.data.length > 0) {
        trailing.push({ data: uncovered.data, seq })
      }
    }
    return trailing
  }
}
