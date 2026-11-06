type TerminalSize = { cols: number; rows: number } | null

/** The PTY's output seq and size now; a gap is only valid if the ring still ends there on the same grid. */
export type PublishedOutputPosition = { seq: number; size: TerminalSize }

export type PublishedTerminalOutput = {
  data: string
  /** PTY output seq after this chunk. */
  seq: number
  rawLength: number
  transformed: boolean
  /** Set when this chunk changed the working directory. */
  cwd?: string
}

const RING_MAX_UNITS = 64 * 1024

// Global so a ring recreated for the same PTY never repeats an epoch a stale ledger recorded.
let nextCoverageEpoch = 1

/** The PTY output already published to stream subscribers, so a phone can resume from what it received. */
export class TerminalPublishedOutputRing {
  /** Changes whenever coverage restarts; output recorded under an older epoch can't be resumed from. */
  epoch = 0
  private chunks: PublishedTerminalOutput[] = []
  private units = 0
  private startSeq = 0
  private endSeq = 0
  private size: TerminalSize = null

  constructor(seq: number, size: TerminalSize) {
    this.resetCoverage(seq, size)
  }

  append(chunk: PublishedTerminalOutput, size: TerminalSize): void {
    const { seq } = chunk
    const startSeq = seq - chunk.rawLength
    // Output written for another grid, or after output that never reached subscribers, replays wrong.
    if (startSeq !== this.endSeq || !sameSize(size, this.size)) {
      this.resetCoverage(startSeq, size)
    }
    this.chunks.push(chunk)
    this.units += chunk.data.length
    this.endSeq = seq
    let dropCount = 0
    while (this.units > RING_MAX_UNITS && dropCount < this.chunks.length) {
      this.units -= this.chunks[dropCount]!.data.length
      dropCount += 1
    }
    if (dropCount > 0) {
      this.startSeq = this.chunks[dropCount - 1]!.seq
      this.chunks.splice(0, dropCount)
    }
  }

  resetCoverage(seq = this.endSeq, size: TerminalSize = this.size): void {
    this.epoch = nextCoverageEpoch++
    this.chunks = []
    this.units = 0
    this.startSeq = seq
    this.endSeq = seq
    this.size = size
  }

  covers(seq: number, epoch: number): boolean {
    return epoch === this.epoch && seq >= this.startSeq
  }

  /** Output published after `seq`, or null unless the ring holds all of it for this grid. */
  readAfter(
    seq: number,
    epoch: number,
    current: PublishedOutputPosition
  ): PublishedTerminalOutput[] | null {
    if (
      epoch !== this.epoch ||
      seq < this.startSeq ||
      seq > this.endSeq ||
      current.seq !== this.endSeq ||
      !sameSize(current.size, this.size)
    ) {
      return null
    }
    const gap: PublishedTerminalOutput[] = []
    for (const chunk of this.chunks) {
      if (chunk.seq <= seq) {
        continue
      }
      const chunkStartSeq = chunk.seq - chunk.rawLength
      if (chunkStartSeq >= seq) {
        gap.push(chunk)
        continue
      }
      // A transformed chunk's text has no per-seq offsets to cut at.
      if (chunk.transformed || chunk.rawLength !== chunk.data.length) {
        return null
      }
      const offset = seq - chunkStartSeq
      gap.push({ ...chunk, data: chunk.data.slice(offset), rawLength: chunk.rawLength - offset })
    }
    return gap
  }
}

function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows
}

type PublishedOutputSource = {
  seq: number
  size: () => TerminalSize
  /** Delivers each chunk as stream subscribers see it. */
  subscribe: (
    listener: (
      data: string,
      meta?: { seq?: number; rawLength?: number; transformed?: boolean; cwd?: string }
    ) => void
  ) => () => void
}

/** Rings exist only while a phone stream, or a stream it may resume, holds one, so desktop-only PTYs pay nothing. */
export class TerminalPublishedOutputRings {
  private readonly rings = new Map<
    string,
    { ring: TerminalPublishedOutputRing; holders: number; unsubscribe: () => void }
  >()

  get(ptyId: string): TerminalPublishedOutputRing | undefined {
    return this.rings.get(ptyId)?.ring
  }

  retain(
    ptyId: string,
    source: PublishedOutputSource
  ): { ring: TerminalPublishedOutputRing; release: () => void } {
    let entry = this.rings.get(ptyId)
    if (!entry) {
      const ring = new TerminalPublishedOutputRing(source.seq, source.size())
      const unsubscribe = source.subscribe((data, meta) => {
        if (typeof meta?.seq !== 'number') {
          ring.resetCoverage()
          return
        }
        ring.append(
          {
            data,
            seq: meta.seq,
            rawLength: meta.rawLength ?? data.length,
            transformed: meta.transformed === true,
            ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {})
          },
          source.size()
        )
      })
      entry = { ring, holders: 0, unsubscribe }
      this.rings.set(ptyId, entry)
    }
    entry.holders += 1
    const held = entry
    let released = false
    return {
      ring: held.ring,
      release: () => {
        if (released) {
          return
        }
        released = true
        held.holders -= 1
        if (held.holders === 0) {
          this.rings.delete(ptyId)
          held.unsubscribe()
        }
      }
    }
  }
}
