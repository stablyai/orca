import {
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession
} from './session-scanner-accumulator'
import { foldMuseLines, type MuseDedupeState } from './session-scanner-muse-parser'
import { museSessionIdFromFilePath } from './session-scanner-muse-paths'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'

export function createMuseSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return resumeState(
    createAccumulator({
      agent: 'muse',
      file,
      sessionId: museSessionIdFromFilePath(file.path),
      messages
    }),
    { text: null, ms: null }
  )
}

function resumeState(
  accumulator: SessionAccumulator,
  dedupe: MuseDedupeState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => foldMuseLines(accumulator, [line], dedupe),
    identity: () => accumulatorSessionIdentity(accumulator),
    // A trailing partial record must not change the next append's dedupe state.
    clone: () => resumeState(cloneSessionAccumulator(accumulator), { ...dedupe }),
    touchFile: (file) => {
      accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) =>
      finalizeSession(cloneSessionAccumulator(accumulator), platform, options)
  }
}
