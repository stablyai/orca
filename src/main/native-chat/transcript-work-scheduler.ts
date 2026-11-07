import { setImmediate } from 'node:timers/promises'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'

export type TranscriptWork<T> = Generator<number, T, void>

export function finishTranscriptWork<T>(work: TranscriptWork<T>): T {
  for (;;) {
    const next = work.next()
    if (next.done) {
      return next.value
    }
  }
}

/** One request shares its budget across records, parsing and message construction. */
export function createTranscriptWorkScheduler(signal?: AbortSignal) {
  let remaining = 256
  return async function run<T>(work: TranscriptWork<T>): Promise<T> {
    try {
      throwIfSignalAborted(signal)
      for (;;) {
        const next = work.next()
        if (next.done) {
          return next.value
        }
        remaining -= next.value
        if (remaining <= 0) {
          await setImmediate()
          throwIfSignalAborted(signal)
          remaining = 256
        }
      }
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Closing discards the generator's result.
      work.return(undefined as never)
    }
  }
}
