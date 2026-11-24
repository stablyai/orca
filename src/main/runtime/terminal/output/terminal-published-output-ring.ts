type TerminalSize = { cols: number; rows: number } | null

export type PublishedTerminalOutput = {
  data: string
  /** PTY output seq after this chunk. */
  seq: number
  rawLength: number
  transformed: boolean
  /** Set when this chunk changed the working directory. */
  cwd?: string
}

/** A seq a client's screen shows, with the coverage epoch and grid it was reached under. */
export type PublishedOutputPoint = { seq: number; epoch: number; size: TerminalSize }

const RING_MAX_UNITS = 64 * 1024

// Global so a ring recreated for the same PTY never repeats an epoch a stale ledger recorded.
let nextCoverageEpoch = 1

/** The PTY output already published to stream subscribers, so a phone can resume from what it received. */
export class TerminalPublishedOutputRing {
  /** Changes whenever coverage restarts; output recorded under an older epoch can't be resumed from. */
  epoch = 0
  private chunks: (PublishedTerminalOutput & { size: TerminalSize })[] = []
  // Chunks before `head` are dropped; compacting only once they are half the array keeps append O(1).
  private head = 0
  private units = 0
  private startSeq = 0
  private endSeq = 0

  constructor(
    seq: number,
    /** The PTY's grid now. */
    readonly currentSize: () => TerminalSize
  ) {
    this.resetCoverage(seq)
  }

  append(chunk: PublishedTerminalOutput): void {
    // Output after output that never reached subscribers can't be stitched onto what a client shows.
    if (chunk.seq - chunk.rawLength !== this.endSeq) {
      this.resetCoverage(chunk.seq - chunk.rawLength)
    }
    this.chunks.push({ ...chunk, size: this.currentSize() })
    this.units += chunk.data.length
    this.endSeq = chunk.seq
    let head = this.head
    while (this.units > RING_MAX_UNITS && head < this.chunks.length) {
      this.units -= this.chunks[head]!.data.length
      head += 1
    }
    if (head === this.head) {
      return
    }
    this.startSeq = this.chunks[head - 1]!.seq
    this.head = head
    if (head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(head)
      this.head = 0
    }
  }

  resetCoverage(seq = this.endSeq): void {
    this.epoch = nextCoverageEpoch++
    this.chunks = []
    this.head = 0
    this.units = 0
    this.startSeq = seq
    this.endSeq = seq
  }

  covers(point: PublishedOutputPoint): boolean {
    return point.epoch === this.epoch && point.seq >= this.startSeq
  }

  /** The point a client reaches by receiving output through `seq`: the grid that output was written for. */
  pointAt(seq: number): PublishedOutputPoint {
    const index = this.chunks.findLastIndex(
      (candidate) => candidate.seq - candidate.rawLength < seq
    )
    const chunk = index >= this.head ? this.chunks[index] : undefined
    const size = chunk && seq <= chunk.seq ? chunk.size : this.currentSize()
    return { seq, epoch: this.epoch, size }
  }

  /** Output published after `point`, or null unless the ring holds all of it, written for the grid the client shows. */
  readAfter(point: PublishedOutputPoint, currentSeq: number): PublishedTerminalOutput[] | null {
    const size = this.currentSize()
    if (
      !this.covers(point) ||
      point.seq > this.endSeq ||
      currentSeq !== this.endSeq ||
      !sameSize(point.size, size)
    ) {
      return null
    }
    const gap: PublishedTerminalOutput[] = []
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const { size: chunkSize, ...chunk } = this.chunks[index]!
      if (chunk.seq <= point.seq) {
        continue
      }
      // Output written for another grid replays wrong on this one.
      if (!sameSize(chunkSize, size)) {
        return null
      }
      const chunkStartSeq = chunk.seq - chunk.rawLength
      if (chunkStartSeq >= point.seq) {
        gap.push(chunk)
        continue
      }
      // A transformed chunk's text has no per-seq offsets to cut at.
      if (chunk.transformed || chunk.rawLength !== chunk.data.length) {
        return null
      }
      const offset = point.seq - chunkStartSeq
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
      const ring = new TerminalPublishedOutputRing(source.seq, source.size)
      const unsubscribe = source.subscribe((data, meta) => {
        if (typeof meta?.seq !== 'number') {
          ring.resetCoverage()
          return
        }
        ring.append({
          data,
          seq: meta.seq,
          rawLength: meta.rawLength ?? data.length,
          transformed: meta.transformed === true,
          ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {})
        })
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
