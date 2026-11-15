import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from '../../terminal/terminal-output-frame-chunks'
import { TerminalStreamOpcode } from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import type {
  PublishedOutputPoint,
  PublishedTerminalOutput,
  TerminalPublishedOutputRing
} from '../../../terminal/output/terminal-published-output-ring'

export type TerminalResumeGap = { seq: number; output: PublishedTerminalOutput[] }

// Points the ring no longer covers are dropped first; this only bounds a flood of tiny frames.
const MAX_RESUME_POINTS = 4096

type ResumePoint = PublishedOutputPoint & { units: number }

/** Maps Output units sent on one stream to the PTY output seq the client's screen then shows. */
export class TerminalStreamResumeLedger {
  private units = 0
  // The seq the client shows after everything sent so far; null once that can't be known.
  private shownSeq: number | null = null
  // The ring coverage the client's screen was drawn from; a reset (clear, respawn) leaves older text on it.
  private epoch: number | null = null
  private points: ResumePoint[] = []
  // Points before `head` are dropped; compacting only once they are half the array keeps each add O(1).
  private head = 0

  constructor(
    readonly ptyId: string,
    private readonly ring: TerminalPublishedOutputRing
  ) {}

  /** The client's screen now shows output through `seq` (a snapshot or a resume point). */
  anchor(seq: number | undefined): void {
    this.shownSeq = seq ?? null
    this.epoch = this.ring.epoch
    if (typeof seq === 'number') {
      // A snapshot or resume reply is drawn for the grid the PTY has now.
      this.addPoint({ seq, epoch: this.ring.epoch, size: this.ring.currentSize() })
    }
  }

  noteSentFrame(opcode: TerminalStreamOpcode): void {
    // A snapshot replaced the client's screen, so earlier counts no longer say what it shows.
    if (opcode === TerminalStreamOpcode.SnapshotStart) {
      this.shownSeq = null
      this.clearPoints()
    }
  }

  /** The text frames for one Output chunk, counted as each is handed out to send. */
  *outputFrames(data: string, meta?: TerminalOutputMeta): Generator<TerminalOutputFrameChunk> {
    const startSeq =
      typeof meta?.seq === 'number' ? meta.seq - (meta.rawLength ?? data.length) : undefined
    // Output that doesn't continue the shown seq ends resume for this stream.
    if (startSeq !== this.shownSeq) {
      this.shownSeq = null
    }
    for (const frame of iterateTerminalOutputFrameChunks(data, meta, 'text')) {
      yield frame
      this.units += frame.displayLength
      if (this.shownSeq !== null && typeof frame.seq === 'number') {
        this.shownSeq = frame.seq
        this.addOutputPoint(frame.seq)
      }
    }
    // A span stripped to nothing sends no frame but still advances the seq the client shows.
    if (this.shownSeq !== null && typeof meta?.seq === 'number' && this.shownSeq !== meta.seq) {
      this.shownSeq = meta.seq
      this.addOutputPoint(meta.seq)
    }
  }

  /** Output the client missed after receiving `units`, or null unless that is a recorded point the ring still holds. */
  readGap(units: number, currentSeq: number): TerminalResumeGap | null {
    const index = this.points.findLastIndex((candidate) => candidate.units === units)
    const point = index >= this.head ? this.points[index] : undefined
    if (!point) {
      return null
    }
    const output = this.ring.readAfter(point, currentSeq)
    return output ? { seq: point.seq, output } : null
  }

  private addOutputPoint(seq: number): void {
    const point = this.ring.pointAt(seq)
    // Output after a reset lands on a screen that still shows text from before it, which no snapshot now matches.
    if (point.epoch !== this.epoch) {
      this.shownSeq = null
      this.clearPoints()
      return
    }
    this.addPoint(point)
  }

  private addPoint(point: PublishedOutputPoint): void {
    if (this.points.at(-1)?.units === this.units) {
      this.points.pop()
    }
    this.points.push({ ...point, units: this.units })
    let head = this.head
    while (head < this.points.length && !this.ring.covers(this.points[head]!)) {
      head += 1
    }
    this.head = Math.max(head, this.points.length - MAX_RESUME_POINTS)
    if (this.head * 2 >= this.points.length) {
      this.points = this.points.slice(this.head)
      this.head = 0
    }
  }

  private clearPoints(): void {
    this.points = []
    this.head = 0
  }
}

/** Output text frames, counted on a resumable stream's ledger as each is handed out to send. */
export function iterateStreamOutputFrames(
  ledger: TerminalStreamResumeLedger | null | undefined,
  data: string,
  meta?: TerminalOutputMeta
): Iterable<TerminalOutputFrameChunk> {
  return ledger
    ? ledger.outputFrames(data, meta)
    : iterateTerminalOutputFrameChunks(data, meta, 'text')
}
