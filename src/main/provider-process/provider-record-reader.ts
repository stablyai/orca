import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type NdjsonRejectedRecord
} from '../../shared/main-process-ndjson-framer'

import { createProviderSourceCompletion } from './provider-source-completion'

export type ProviderRecordReader = {
  pause: () => void
  resume: () => void
  finish: () => Promise<void>
}

export function createProviderRecordReader(input: {
  stdout: Readable
  onRecord: (record: unknown, line: string) => void
  onRejected: (rejected: NdjsonRejectedRecord) => void
  onFatal: (error: Error) => void
}): ProviderRecordReader {
  let paused = false
  const framer = createIncrementalNdjsonFramer(input.onRecord, input.onRejected, {
    // The provider owns this local stdio stream, so valid agent payloads keep full fidelity.
    maxLineBytes: Number.POSITIVE_INFINITY,
    shouldPause: () => paused
  })

  const source = createProviderSourceCompletion(input.stdout, {
    data: (chunk) => framer.feed(chunk),
    end: (natural) => framer.finish(natural),
    error: (error) => {
      paused = false
      framer.finish(false)
      input.onFatal(error)
    },
    draining: () => {
      paused = false
      framer.drain()
    }
  })

  return {
    finish: source.finish,
    pause: () => {
      if (source.ending) {
        return
      }
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
