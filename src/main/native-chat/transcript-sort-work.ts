import type { TranscriptWork } from './transcript-work-scheduler'

/** Stable in-place ordering with the same comparator as the synchronous projection. */
export function* sortTranscriptWork<T>(
  values: T[],
  compare: (a: T, b: T) => number
): TranscriptWork<T[]> {
  const scratch: (T | undefined)[] = []
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start + width < values.length; start += width * 2) {
      yield 1
      const middle = start + width
      const end = Math.min(start + width * 2, values.length)
      if (compare(values[middle - 1]!, values[middle]!) <= 0) {
        continue
      }
      let left = start
      let right = middle
      for (let index = start; index < end; index++) {
        scratch[index] =
          right >= end || (left < middle && compare(values[left]!, values[right]!) <= 0)
            ? values[left++]!
            : values[right++]!
        yield 1
      }
      for (let index = start; index < end; index++) {
        values[index] = scratch[index]!
        scratch[index] = undefined
        yield 1
      }
    }
  }
  return values
}
