import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { consumeCompleteJsonlLines } from './session-scanner-jsonl-reader'
import type { ResumableSessionParseState, SessionFileCandidate } from './session-scanner-types'
import {
  invalidateSessionParseCacheEntry,
  type SessionParseResumePoint
} from './session-parse-cache-store'
import { TranscriptMessageChannel } from './session-transcript-channel'
import { mergeSkippedTranscriptRecords } from './session-transcript-record-budget'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

type TranscriptSessionEnrichment = {
  /** Complete consumer metadata before committing; the returned fold stays unmodified. */
  sessionForConsumers?: (session: AiVaultSession | null) => Promise<AiVaultSession | null>
}

const NEWLINE_BYTE = 0x0a

export type TranscriptReadStats = {
  incremental: number
  fullParses: number
  // Count excluded transcripts separately from incremental reads; no bytes were consumed.
  earlyStopped: number
  bytesRead: number
}

export type ResumableTranscriptRead = {
  session: AiVaultSession | null
  resume: SessionParseResumePoint
}

/** Drop the reader-owned resume point so lagging consumers can receive a full replacement stream. */
export function requestWholeTranscriptRead(path: string): void {
  invalidateSessionParseCacheEntry(path)
}

/** Resume append-only transcripts only while the recorded offset remains on a valid line boundary. */
export async function readResumableTranscript(
  args: TranscriptSessionEnrichment & {
    candidate: SessionFileCandidate
    platform: NodeJS.Platform
    resume: SessionParseResumePoint | null
    stateFactory: (messages: TranscriptMessageChannel) => ResumableSessionParseState
    stats?: TranscriptReadStats
    signal?: AbortSignal
  }
): Promise<ResumableTranscriptRead> {
  const { file } = args.candidate
  const resume = args.resume
  const canResume =
    resume !== null &&
    typeof file.sizeBytes === 'number' &&
    file.sizeBytes >= resume.byteOffset &&
    file.mtimeMs >= resume.mtimeMs &&
    // A changed timestamp without growth signals a rewrite, even at a valid line boundary.
    (file.mtimeMs === resume.mtimeMs || file.sizeBytes > (resume.sizeBytes ?? resume.byteOffset)) &&
    (resume.byteOffset === 0 ||
      (await endsWithNewlineAt(file.path, resume.byteOffset, args.signal)))

  // Isolate cached state so failed reads cannot double-count lines on retry.
  const channel = canResume ? resume.channel : new TranscriptMessageChannel()
  const state = canResume ? resume.state.clone() : args.stateFactory(channel)
  const startOffset = canResume ? resume.byteOffset : 0
  const stoppedBeforeRead = state.shouldStop?.() === true
  if (args.stats) {
    if (stoppedBeforeRead) {
      args.stats.earlyStopped++
    } else if (canResume) {
      args.stats.incremental++
    } else {
      args.stats.fullParses++
    }
  }

  channel.beginRead({
    candidate: args.candidate,
    mode: canResume ? 'append' : 'replace',
    previousByteOffset: startOffset,
    identity: () => state.identity?.() ?? null
  })
  try {
    const readResult = await consumeCompleteJsonlLines({
      path: file.path,
      start: startOffset,
      onLine: (line) => state.consumeLine(line),
      // Preserve `this` for parsers that implement these hooks as methods.
      onLineBytes: state.consumeLineBytes?.bind(state),
      shouldStop: state.shouldStop?.bind(state),
      signal: args.signal
    })
    if (args.stats) {
      args.stats.bytesRead += readResult.bytesRead
    }

    state.touchFile(file)

    // Show an unterminated tail without caching or publishing it until the line is complete.
    let displayState = state
    if (readResult.trailingPartialLine !== null) {
      const partialLine = readResult.trailingPartialLine
      displayState = state.clone()
      channel.mute(() => displayState.consumeLine(partialLine))
    }

    const session = await displayState.finalize(args.platform)
    const consumerSession = args.sessionForConsumers
      ? await args.sessionForConsumers(session)
      : session
    throwIfAiVaultScanCancelled(args.signal)
    channel.finishRead({
      session: consumerSession,
      byteOffset: readResult.consumedThrough,
      incomplete: false
    })
    return {
      session,
      resume: {
        state,
        byteOffset: readResult.consumedThrough,
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        channel,
        // Retain earlier skips only for append reads; replacements revisit those records.
        skippedRecords: mergeSkippedTranscriptRecords(
          canResume ? resume.skippedRecords : [],
          readResult.skippedRecords
        )
      }
    }
  } catch (error) {
    channel.finishRead({
      session: null,
      byteOffset: startOffset,
      incomplete: true,
      cancelled: args.signal?.aborted === true
    })
    throw error
  }
}

/** Rewritten document formats always publish a whole-file replacement with no resume cursor. */
export async function readWholeTranscript(
  args: TranscriptSessionEnrichment & {
    candidate: SessionFileCandidate
    platform: NodeJS.Platform
    stats?: TranscriptReadStats
    signal?: AbortSignal
  }
): Promise<AiVaultSession | null> {
  const { file } = args.candidate
  if (args.stats) {
    args.stats.fullParses++
    args.stats.bytesRead += file.sizeBytes ?? 0
  }
  const channel = new TranscriptMessageChannel()
  channel.beginRead({ candidate: args.candidate, mode: 'replace', previousByteOffset: 0 })
  try {
    const session = await parseAgentSessionFile(args.candidate, args.platform, channel, args.signal)
    const consumerSession = args.sessionForConsumers
      ? await args.sessionForConsumers(session)
      : session
    throwIfAiVaultScanCancelled(args.signal)
    channel.finishRead({
      session: consumerSession,
      byteOffset: file.sizeBytes ?? 0,
      incomplete: false
    })
    return session
  } catch (error) {
    channel.finishRead({
      session: null,
      byteOffset: 0,
      incomplete: true,
      cancelled: args.signal?.aborted === true
    })
    throw error
  }
}

// Heuristic: a growing rewrite can preserve this newline and evade detection until cache invalidation.
async function endsWithNewlineAt(
  path: string,
  offset: number,
  signal?: AbortSignal
): Promise<boolean> {
  const slice = await readTranscriptSlice(path, offset - 1, 1, 'scan', signal)
  return slice.length === 1 && slice[0] === NEWLINE_BYTE
}
