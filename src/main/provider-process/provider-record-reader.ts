import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type NdjsonRejectedRecord
} from '../../shared/json-stream/main-process-ndjson-framer'
import {
  countedRelayRecords,
  type ProviderRelayRecordTaking
} from '../provider-relay/relayed-provider-consumption'

/**
 * Far above valid replies (large diffs and image turns have passed 16 MB), but bounds what one
 * line can make main buffer and parse.
 */
export const PROVIDER_RECORD_MAX_LINE_BYTES = 128 * 2 ** 20

type RecordReaderStream = Pick<Readable, 'on' | 'pause' | 'resume' | 'setEncoding'> & {
  /** A relayed agent's stream: each record is reported once handled, so acks never pass it. */
  relayRecords?: ProviderRelayRecordTaking
}

export type ProviderRecordReader = {
  pause: () => void
  resume: () => void
}

/**
 * Runs of records the consumer takes as one (same-task batching). A run is handed on before the
 * reader reads a line that doesn't continue it, or at the end of the current task, so a pause its
 * handler applies stops reading exactly where it would have after the last line of the run.
 */
export type ProviderRecordMerging<Held> = {
  /** A run this record starts, or null. */
  start: (record: unknown) => Held | null
  /** Whether the unparsed line at `start` in `text` may continue the run. */
  continues: (held: Held, text: string, start: number) => boolean
  /** Folds `record` into the run; false when it doesn't continue it. */
  add: (held: Held, record: unknown) => boolean
  /** The one record the run hands on. */
  finish: (held: Held) => unknown
}

export function createProviderRecordReader<Held = never>(input: {
  stdout: RecordReaderStream
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
  merging?: ProviderRecordMerging<Held>
}): ProviderRecordReader {
  let paused = false
  const counted = countedRelayRecords(input.stdout, input.onRecord, input.onRejected)
  const merging = input.merging
  // Counted as taken only when handed on, so relay acks never pass a held line.
  let run: { held: Held; line: string; lines: number } | null = null
  let flushQueued = false
  /** One record read after a run whose handler paused; handed on first on resume. */
  let afterPause: (() => void) | null = null

  const flush = (): void => {
    if (!run || !merging) {
      return
    }
    const { held, line, lines } = run
    run = null
    counted.onRecord(merging.finish(held), line, lines)
  }
  const flushOrFail = (): void => {
    try {
      flush()
    } catch (error) {
      input.onFatal(error instanceof Error ? error : new Error(String(error)))
    }
  }
  // nextTick, not a microtask: it then runs ahead of a stream end emitted after this read.
  const queueFlush = (): void => {
    if (flushQueued) {
      return
    }
    flushQueued = true
    process.nextTick(() => {
      flushQueued = false
      flushOrFail()
    })
  }
  // A line that looked like a continuation but wasn't: it waits out a pause the run applied.
  const afterRun = (handOn: () => void): void => {
    flush()
    if (paused) {
      afterPause = handOn
    } else {
      handOn()
    }
  }
  const onRecord = (record: unknown, line: string): void => {
    if (run && merging) {
      if (merging.add(run.held, record)) {
        run.line = line
        run.lines += 1
        return
      }
      afterRun(() => counted.onRecord(record, line))
      return
    }
    const held = merging?.start(record) ?? null
    if (held === null) {
      counted.onRecord(record, line)
      return
    }
    run = { held, line, lines: 1 }
    queueFlush()
  }
  const onRejected = (rejected: NdjsonRejectedRecord): void =>
    run ? afterRun(() => counted.onRejected(rejected)) : counted.onRejected(rejected)

  const framer = createIncrementalNdjsonFramer(onRecord, onRejected, {
    maxLineBytes: PROVIDER_RECORD_MAX_LINE_BYTES,
    shouldPause: () => paused,
    ...(merging
      ? {
          // Always ahead of a line while paused: a flush in any callback may have paused reading.
          beforeLine: (text: string, start: number) => {
            if (run && !merging.continues(run.held, text, start)) {
              flush()
            }
            return paused
          }
        }
      : {})
  })

  input.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    try {
      framer.feed(chunk)
    } catch (error) {
      input.onFatal(error instanceof Error ? error : new Error(String(error)))
    }
  })
  if (merging) {
    input.stdout.on('end', flushOrFail)
  }

  return {
    pause: () => {
      paused = true
      input.stdout.pause()
    },
    resume: () => {
      if (!paused) {
        return
      }
      paused = false
      const first = afterPause
      afterPause = null
      first?.()
      if (paused) {
        return
      }
      framer.resume()
      if (!paused) {
        input.stdout.resume()
      }
    }
  }
}
