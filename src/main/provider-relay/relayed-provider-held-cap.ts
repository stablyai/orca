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
