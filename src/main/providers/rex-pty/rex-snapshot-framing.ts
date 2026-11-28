const MAX_SNAPSHOT = 64 * 1024 * 1024
const HEADER_SIZE = 10

/** Discards a version-1 snapshot without decoding its terminal state; returns the live VT boundary. */
export class RexSnapshotFramer {
  private readonly header = Buffer.alloc(HEADER_SIZE)
  private filled = 0
  private total = 0
  private remaining = 0
  private finishRecord = false
  private phase: 'envelope' | 'record' | 'payload' | 'done' = 'envelope'

  feed(chunk: Buffer): number | null {
    let offset = 0
    while (this.phase !== 'done') {
      if (this.phase === 'payload') {
        const take = Math.min(this.remaining, chunk.length - offset)
        this.remaining -= take
        offset += take
        this.total += take
        if (this.remaining !== 0) {
          return null
        }
        this.phase = this.finishRecord ? 'done' : 'record'
        continue
      }
      const take = Math.min(HEADER_SIZE - this.filled, chunk.length - offset)
      chunk.copy(this.header, this.filled, offset, offset + take)
      this.filled += take
      offset += take
      this.total += take
      if (this.total > MAX_SNAPSHOT) {
        throw new Error('Rex snapshot too large')
      }
      if (this.filled !== HEADER_SIZE) {
        return null
      }
      this.filled = 0
      if (this.phase === 'envelope') {
        if (
          this.header.subarray(0, 8).toString() !== 'GHOSTSNP' ||
          this.header.readUInt16LE(8) !== 1
        ) {
          throw new Error('Unsupported Rex snapshot')
        }
        this.phase = 'record'
      } else {
        this.finishRecord = this.header.readUInt16LE(0) === 6
        this.remaining = this.header.readUInt32LE(2)
        if (this.total + this.remaining > MAX_SNAPSHOT) {
          throw new Error('Rex snapshot record too large')
        }
        this.phase = 'payload'
      }
    }
    return offset
  }
}

export function snapshotEnd(bytes: Buffer): number | null {
  return new RexSnapshotFramer().feed(bytes)
}
