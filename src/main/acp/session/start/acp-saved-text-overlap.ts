/** Shorter overlaps are left in: a few repeated characters are cheaper than dropping real text. */
const MIN_OVERLAP_CHARS = 16
/** Past this many places the replay could start in the saved text, it is taken as new text. */
const MAX_CANDIDATES = 64

/**
 * The saved text of a message and the chunks the agent's replay sends for it next. Text is saved on
 * its own schedule, so the saved row can already hold the replay's first chunks (saved, then the
 * app quit before acking them). The saved text ends at a chunk boundary, so the replay repeats a
 * tail of it exactly when the chunks so far match the saved text up to its end.
 */
export class AcpSavedTextOverlap {
  private replayed = ''
  private candidates: number[] | null = null

  constructor(private readonly saved: string) {}

  /** The text the message reads so far, once known; null while the replay may still repeat it. */
  add(chunk: string): string | null {
    this.replayed += chunk
    if (this.candidates === null) {
      this.candidates = []
      for (
        let at = this.saved.indexOf(this.replayed);
        at !== -1 && this.candidates.length <= MAX_CANDIDATES;
        at = this.saved.indexOf(this.replayed, at + 1)
      ) {
        this.candidates.push(at)
      }
      if (this.candidates.length > MAX_CANDIDATES) {
        return this.settle()
      }
    } else {
      this.candidates = this.candidates.filter((at) => this.saved.startsWith(this.replayed, at))
    }
    if (
      this.replayed.length >= MIN_OVERLAP_CHARS &&
      this.candidates.some((at) => at + this.replayed.length === this.saved.length)
    ) {
      // The replay so far is the saved text's tail: those chunks were saved already.
      return this.saved
    }
    return this.candidates.length === 0 ? this.settle() : null
  }

  /** No further chunk can tell: the replay so far is new text after the saved text. */
  settle(): string {
    return this.saved + this.replayed
  }
}
