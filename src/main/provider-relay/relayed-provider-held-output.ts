/** Output held while a chat reopens stays under this; past it the oldest half is let go. */
const HELD_MAX_CHARS = 64 * 1024 * 1024

/** `seq` null is a held request; `line` '' only advances the cursor. */
export type HeldOutputLine = { seq: number | null; line: string }

/**
 * A reopen that never finishes can't grow main's memory for good: past the cap the oldest held
 * output goes (one cursor entry still passes it, so it's acked), and what follows continues its
 * items on new rows. Held requests stay, as they must still be answered. Null under the cap.
 */
export function cutHeldOutput(
  held: readonly HeldOutputLine[],
  chars: number,
  max = HELD_MAX_CHARS
): { held: HeldOutputLine[]; chars: number; through: number } | null {
  if (chars <= max) {
    return null
  }
  const kept: HeldOutputLine[] = []
  let through: number | null = null
  let left = chars
  let at = 0
  for (; at < held.length && left > max / 2; at++) {
    const entry = held[at]!
    if (entry.seq === null) {
      kept.push(entry)
      continue
    }
    left -= entry.line.length
    through = entry.seq
  }
  return through === null
    ? null
    : { held: [...kept, { seq: through, line: '' }, ...held.slice(at)], chars: left, through }
}

/** Output held until the chat is ready, handed on in order by `next()`. */
export class RelayedProviderHeldOutput {
  private lines: HeldOutputLine[] = []
  private releasedTo = 0
  private chars = 0
  /** Requests held, not yet handed on: a reconnect that drops them must have them asked again. */
  private readonly pending = new Set<number>()

  holdRequest(pendingSeq: number, line: string): void {
    this.pending.add(pendingSeq)
    this.lines.push({ seq: null, line })
  }

  /** A line, or (`line` '') only the cursor; past the cap the oldest goes, through the seq returned. */
  hold(seq: number | null, line: string, mayCut: boolean): number | null {
    this.lines.push({ seq, line })
    this.chars += line.length
    const cut = mayCut ? cutHeldOutput(this.lines, this.chars) : null
    if (cut) {
      this.lines = cut.held
      this.chars = cut.chars
    }
    return cut?.through ?? null
  }

  next(): HeldOutputLine | undefined {
    return this.lines[this.releasedTo++]
  }

  get more(): boolean {
    return this.releasedTo < this.lines.length
  }

  /** Drops everything held; returns the requests never handed on, to be asked again. */
  reset(): number[] {
    const requests = [...this.pending]
    this.lines = []
    this.releasedTo = 0
    this.chars = 0
    this.pending.clear()
    return requests
  }

  /** The first spool line still held past `released`, not yet handed on. */
  firstAfter(released: number): number | null {
    for (let at = this.releasedTo; at < this.lines.length; at++) {
      const { seq } = this.lines[at]!
      if (seq !== null && seq > released) {
        return seq
      }
    }
    return null
  }
}
