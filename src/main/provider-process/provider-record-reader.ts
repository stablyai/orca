import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type NdjsonRejectedRecord
} from '../../shared/json-stream/main-process-ndjson-framer'

/**
 * Far above valid replies (large diffs and image turns have passed 16 MB), but bounds what one
 * line can make main buffer and parse.
 */
export const PROVIDER_RECORD_MAX_LINE_BYTES = 128 * 2 ** 20

type RecordReaderStream = Pick<Readable, 'on' | 'pause' | 'resume' | 'setEncoding'>

export type ProviderRecordReader = {
  pause: () => void
  resume: () => void
}

export function createProviderRecordReader(input: {
  stdout: RecordReaderStream
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
}): ProviderRecordReader {
  let paused = false
  const framer = createIncrementalNdjsonFramer(input.onRecord, input.onRejected, {
    maxLineBytes: PROVIDER_RECORD_MAX_LINE_BYTES,
    shouldPause: () => paused
  })

  input.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    try {
      framer.feed(chunk)
    } catch (error) {
      input.onFatal(error instanceof Error ? error : new Error(String(error)))
    }
  })

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
      framer.resume()
      if (!paused) {
        input.stdout.resume()
      }
    }
  }
}
