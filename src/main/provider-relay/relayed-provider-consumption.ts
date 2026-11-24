/** Lines handed on before any reader claimed them; past this, acks follow what was handed on. */
const MAX_UNCLAIMED_LINES = 4_096

/**
 * The stream hook a record reader calls so a relay acks only what the chat actually took: a
 * paused reader (a journal drain) leaves lines in the stream or its framer, and a crash then must
 * replay them. A reader that never claims keeps acks on what was handed on.
 */
export type ProviderRelayRecordTaking = {
  claim: () => void
  taken: () => void
  /** The reader dropped lines without a record each, so its count no longer lines up. */
  uncounted: () => void
}

/** Which seq the consumer has taken, one entry per line handed on and not yet taken. */
export class RelayedProviderConsumption {
  private mode: 'unclaimed' | 'claimed' | 'off' = 'unclaimed'
  /** The seq covered once each queued line is taken; `head` is the next one the reader takes. */
  private readonly after: number[] = []
  private head = 0
  private consumed = 0

  constructor(private readonly onTaken: () => void) {}

  readonly taking: ProviderRelayRecordTaking = {
    claim: () => {
      if (this.mode === 'unclaimed') {
        this.mode = 'claimed'
      }
    },
    uncounted: () => {
      this.mode = 'off'
      this.reset(0)
      this.onTaken()
    },
    taken: () => {
      if (this.head < this.after.length) {
        this.consumed = Math.max(this.consumed, this.after[this.head++] as number)
        if (this.head > 1_024 && this.head * 2 > this.after.length) {
          this.after.splice(0, this.head)
          this.head = 0
        }
        this.onTaken()
      }
    }
  }

  reset(seq: number): void {
    this.after.length = 0
    this.head = 0
    this.consumed = seq
  }

  /** A line (or, with `line` false, only the cursor) went onto the stream; `seq` is the cursor now. */
  pushed(line: boolean, seq: number): void {
    if (this.mode === 'off') {
      return
    }
    if (line) {
      this.after.push(seq)
    } else if (this.head === this.after.length) {
      this.consumed = Math.max(this.consumed, seq)
    } else {
      this.after[this.after.length - 1] = seq
    }
    if (this.mode === 'unclaimed' && this.after.length - this.head > MAX_UNCLAIMED_LINES) {
      this.mode = 'off'
      this.reset(0)
    }
  }

  /** The highest seq acks may cover: what was taken, or everything handed on if no reader claims. */
  upTo(pushedSeq: number): number {
    return this.mode === 'claimed' ? Math.min(this.consumed, pushedSeq) : pushedSeq
  }
}
