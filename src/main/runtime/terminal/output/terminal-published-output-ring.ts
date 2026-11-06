type TerminalSize = { cols: number; rows: number } | null

export type PublishedTerminalOutput = {
  data: string
  /** PTY output seq after this chunk. */
  seq: number
  rawLength: number
  transformed: boolean
}

const RING_MAX_UNITS = 64 * 1024

// Global so a ring recreated for the same PTY never repeats an epoch a stale ledger recorded.
let nextCoverageEpoch = 1

/** The PTY output already published to stream subscribers, so a phone can resume from what it received. */
export class TerminalPublishedOutputRing {
  /** Changes whenever coverage restarts; output recorded under an older epoch can't be resumed from. */
  epoch = nextCoverageEpoch++
  private chunks: PublishedTerminalOutput[] = []
  private units = 0
  private startSeq: number
  endSeq: number
  private size: TerminalSize

  constructor(seq: number, size: TerminalSize) {
    this.startSeq = seq
    this.endSeq = seq
    this.size = size
  }

  append(
    data: string,
    seq: number,
    rawLength: number,
    transformed: boolean,
    size: TerminalSize
  ): void {
    const startSeq = seq - rawLength
    // Output written for another grid, or after output that never reached subscribers, replays wrong.
    if (startSeq !== this.endSeq || !sameSize(size, this.size)) {
      this.resetCoverage(startSeq, size)
    }
    this.chunks.push({ data, seq, rawLength, transformed })
    this.units += data.length
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

  resetCoverage(seq: number, size: TerminalSize = this.size): void {
    this.epoch = nextCoverageEpoch++
    this.chunks = []
    this.units = 0
    this.startSeq = seq
    this.endSeq = seq
    this.size = size
  }

  /** Output published after `seq`, or null unless the ring holds all of it for this grid. */
  readAfter(
    seq: number,
    epoch: number,
    current: { seq: number; size: TerminalSize }
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
  /** Delivers each chunk as stream subscribers see it, before any subscriber registered later. */
  subscribe: (
    listener: (
      data: string,
      meta?: { seq?: number; rawLength?: number; transformed?: boolean }
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
          ring.resetCoverage(ring.endSeq)
          return
        }
        const rawLength = meta.rawLength ?? data.length
        ring.append(data, meta.seq, rawLength, meta.transformed === true, source.size())
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
        if (held.holders === 0 && this.rings.get(ptyId) === held) {
          this.rings.delete(ptyId)
          held.unsubscribe()
        }
      }
    }
  }
}
