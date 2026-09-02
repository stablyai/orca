import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type NdjsonRejectedRecord
} from '../../shared/main-process-ndjson-framer'

type RecordReaderStream = Pick<Readable, 'on' | 'pause' | 'resume' | 'setEncoding'>

export type CodexAppServerRecordReader = {
  pause: () => void
  resume: () => void
}

export function createCodexAppServerRecordReader(input: {
  stdout: RecordReaderStream
  maxRecordBytes: number
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
}): CodexAppServerRecordReader {
  let paused = false
  const framer = createIncrementalNdjsonFramer(input.onRecord, input.onRejected, {
    maxLineBytes: input.maxRecordBytes,
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
