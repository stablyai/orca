const MAX_STEP_TEXT_CHARS = 8_192

export type PendingLaggingItem =
  | { kind: 'thought'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; sig: string }

export type BoundedTextRun = {
  head: string
  tail: string
  totalLen: number
  consumedOffset: number
}

/** Append streaming text to bounded head and tail slices while tracking total length and consumption offset. */
export function appendBoundedRunText(run: BoundedTextRun, chunk: string): BoundedTextRun {
  const head =
    run.head.length < MAX_STEP_TEXT_CHARS
      ? (run.head + chunk).slice(0, MAX_STEP_TEXT_CHARS)
      : run.head
  return {
    head,
    tail: (run.tail + chunk).slice(-MAX_STEP_TEXT_CHARS),
    totalLen: run.totalLen + chunk.length,
    consumedOffset: run.consumedOffset
  }
}

/** Consume streaming chunk prefixes in order from the head of `sequence` when matching `kind`. */
export function consumeLaggingSequenceText(
  sequence: PendingLaggingItem[],
  kind: 'thought' | 'message',
  rawChunk: string
): boolean {
  let chunk = rawChunk.trimStart()
  while (chunk.length > 0) {
    const head = sequence[0]
    if (!head || head.kind !== kind) {
      return false
    }
    if (!head.text) {
      sequence.shift()
      continue
    }
    if (head.text.startsWith(chunk)) {
      head.text = head.text.slice(chunk.length).trimStart()
      if (!head.text) {
        sequence.shift()
      }
      return true
    }
    const trimmed = chunk.trimEnd()
    if (trimmed && head.text === trimmed) {
      sequence.shift()
      return true
    }
    if (chunk.startsWith(head.text)) {
      sequence.shift()
      chunk = chunk.slice(head.text.length).trimStart()
      continue
    }
    return false
  }
  return true
}

/** Match and consume `expected` once from the earliest matching bounded text run in `runs`. */
export function consumeBoundedTextRun(runs: BoundedTextRun[], expected: string): boolean {
  const half = Math.floor(MAX_STEP_TEXT_CHARS / 2)
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]
    if (!run || run.consumedOffset >= run.totalLen) {
      continue
    }
    const tailStart = Math.max(0, run.totalLen - run.tail.length)
    if (expected.length <= MAX_STEP_TEXT_CHARS) {
      if (run.consumedOffset < run.head.length) {
        const pos = run.head.indexOf(expected, run.consumedOffset)
        if (pos !== -1) {
          runs.splice(0, i)
          runs[0] = { ...run, consumedOffset: pos + expected.length }
          return true
        }
      }
      const tailSearchFrom = Math.max(0, run.consumedOffset - tailStart)
      const tailPos = run.tail.indexOf(expected, tailSearchFrom)
      if (tailPos !== -1) {
        runs.splice(0, i)
        runs[0] = { ...run, consumedOffset: tailStart + tailPos + expected.length }
        return true
      }
    } else {
      const headSearchFrom = Math.min(run.head.length, run.consumedOffset)
      const hPos = run.head.indexOf(expected.slice(0, half), headSearchFrom)
      const matchEnd = hPos + expected.length
      const suffixSliceStart = matchEnd - half - tailStart
      if (
        hPos !== -1 &&
        suffixSliceStart >= 0 &&
        suffixSliceStart + half <= run.tail.length &&
        run.tail.startsWith(expected.slice(-half), suffixSliceStart)
      ) {
        runs.splice(0, i)
        runs[0] = { ...run, consumedOffset: matchEnd }
        return true
      }
    }
  }
  return false
}
