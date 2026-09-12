import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  NdjsonLineTooLongError,
  type NdjsonRejectedRecord
} from '../../shared/main-process-ndjson-framer'

export const CODEX_APP_SERVER_MAX_RECORD_BYTES = 32 * 1024 * 1024

type RecordReaderStream = Pick<Readable, 'on' | 'pause' | 'resume' | 'setEncoding'>

export type CodexAppServerRecordReader = {
  pause: () => void
  resume: () => void
}

export function createCodexAppServerRecordReader(input: {
  stdout: RecordReaderStream
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
}): CodexAppServerRecordReader {
  let paused = false
  let failed = false
  const fail = (error: unknown): void => {
    if (failed) {
      return
    }
    failed = true
    paused = true
    input.stdout.pause()
    framer.reset()
    input.onFatal(error instanceof Error ? error : new Error(String(error)))
  }
  const framer = createIncrementalNdjsonFramer(
    input.onRecord,
    (rejected) => {
      // A missing provider record invalidates the connection; never continue with clipped history.
      if (rejected.kind === 'line-too-long') {
        throw new NdjsonLineTooLongError(rejected.observedBytes, rejected.maxLineBytes)
      }
      input.onRejected(rejected)
    },
    {
      maxLineBytes: CODEX_APP_SERVER_MAX_RECORD_BYTES,
      shouldPause: () => paused
    }
  )

  input.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (failed) {
      return
    }
    try {
      framer.feed(chunk)
    } catch (error) {
      fail(error)
    }
  })

  return {
    pause: () => {
      paused = true
      input.stdout.pause()
    },
    resume: () => {
      if (failed || !paused) {
        return
      }
      paused = false
      try {
        framer.resume()
      } catch (error) {
        fail(error)
        return
      }
      if (!paused) {
        input.stdout.resume()
      }
    }
  }
}
