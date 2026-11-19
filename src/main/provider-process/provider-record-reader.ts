import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type IncrementalNdjsonFramerOptions,
  type NdjsonRejectedRecord
} from '../../shared/json-stream/main-process-ndjson-framer'

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
  largeRecordParser?: IncrementalNdjsonFramerOptions['largeRecordParser']
}): ProviderRecordReader {
  let paused = false
  const framer = createIncrementalNdjsonFramer(input.onRecord, input.onRejected, {
    // The provider owns this local stdio stream, so valid agent payloads keep full fidelity.
    maxLineBytes: Number.POSITIVE_INFINITY,
    largeRecordParser: input.largeRecordParser,
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
