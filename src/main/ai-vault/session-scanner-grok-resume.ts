import { dirname, join } from 'node:path'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import {
  accumulatorSessionIdentity,
  cloneSessionAccumulator,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName
} from './session-scanner-accumulator'
import { observeSessionSidecar } from './session-scanner-discovery'
import { applyGrokSummary, consumeGrokHistoryLine } from './session-scanner-grok-parser'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator,
  SessionFileCandidate
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { asRecord } from './session-scanner-values'

export async function observeGrokHistory(
  candidate: SessionFileCandidate
): Promise<SessionFileCandidate> {
  if (candidate.file.sidecar !== undefined) {
    return candidate
  }
  return {
    ...candidate,
    file: {
      ...candidate.file,
      sidecar: await observeSessionSidecar(join(dirname(candidate.file.path), 'chat_history.jsonl'))
    }
  }
}

export function grokHistoryFile(candidate: SessionFileCandidate): FileWithMtime | undefined {
  const sidecar = candidate.file.sidecar
  return typeof sidecar === 'object'
    ? { ...sidecar, modifiedAt: new Date(sidecar.mtimeMs).toISOString() }
    : undefined
}

export function createGrokSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return resumeState(
    createAccumulator({
      agent: 'grok',
      file,
      sessionId: sessionIdFromFileName(dirname(file.path)),
      messages
    })
  )
}

function resumeState(accumulator: SessionAccumulator): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeGrokHistoryLine(accumulator, line),
    identity: () => accumulatorSessionIdentity(accumulator),
    clone: () => resumeState(cloneSessionAccumulator(accumulator)),
    touchFile: (file) => {
      accumulator.modifiedAt = file.modifiedAt
    },
    finalize: async (platform, options) => {
      // Summary fields are rewritten; never bake them into the append-only history fold.
      const value: unknown = JSON.parse(
        await wslGatedReadFile(accumulator.filePath, 'utf-8', 'scan')
      )
      const summary = asRecord(value)
      if (!summary) {
        return null
      }
      const snapshot = cloneSessionAccumulator(accumulator)
      applyGrokSummary(snapshot, summary)
      return finalizeSession(snapshot, platform, options)
    }
  }
}
