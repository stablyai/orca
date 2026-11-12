import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../scan-lifecycle/ai-vault-scan-cancellation'
import { createHash } from 'node:crypto'
import { readTranscriptSlice } from '../../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { parseAgentSessionFile } from '../parsing/session-scanner-agent-parser'
import { consumeCompleteJsonlLines } from '../parsing/session-scanner-jsonl-reader'
import { isZstdTranscriptPath } from '../../native-chat/transcript-zstd-decompression'
import type { ResumableSessionParseState, SessionFileCandidate } from '../session-scanner-types'
import {
  invalidateSessionParseCacheEntry,
  type SessionParseResumePoint
} from '../parse-cache/session-parse-cache-store'
import { TranscriptMessageChannel } from './session-transcript-channel'
import { hasTranscriptConsumers, transcriptResumableOffsets } from './session-transcript-consumers'
import {
  mergeSkippedTranscriptRecords,
  type SkippedTranscriptRecord
} from './session-transcript-record-budget'

type TranscriptSessionEnrichment = {
  /** Complete consumer metadata before committing; the returned fold stays unmodified. */
  indexing?: boolean
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
  // Codex .jsonl.zst archives never grow; decoded offsets cannot address their compressed bytes.
  const archived = isZstdTranscriptPath(file.path)
  const canResume =
    !archived &&
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

  // Hash only for consumers: they compare prefixes after a restart drops this resume point.
  const prefixHash = canResume
    ? (resume.prefixHash?.copy() ?? null)
    : !archived && hasTranscriptConsumers()
      ? createHash('sha256')
      : null
  const prefixOffsets =
    !canResume && prefixHash ? nonEmpty(transcriptResumableOffsets(args.candidate)) : undefined
  channel.beginRead({
    candidate: args.candidate,
    indexing: args.indexing,
    signal: args.signal,
    mode: canResume ? 'append' : 'replace',
    previousByteOffset: startOffset,
    identity: () => state.identity?.() ?? null,
    prefixOffsets
  })
  try {
    // Archives are covered through their compressed size, which search cursors compare to stat size.
    const coveredThrough = archived ? (file.sizeBytes ?? 0) : null
    const readResult = await consumeCompleteJsonlLines({
      path: file.path,
      start: startOffset,
      prefixHash,
      prefixCheckpoints: prefixOffsets && {
        offsets: prefixOffsets,
        reached: (offset, digest) => channel.prefixReached(offset, digest)
      },
      onLine: (line) => state.consumeLine(line),
      drain: () => channel.drain(),
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

    const skippedRecords = mergeSkippedTranscriptRecords(
      canResume ? resume.skippedRecords : [],
      readResult.skippedRecords
    )
    throwIfAiVaultScanCancelled(args.signal)
    let session = await displayState.finalize(args.platform, { signal: args.signal })
    if (session?.conversationContent === 'empty' && skippedRecords.length > 0) {
      session = { ...session, conversationContent: 'unknown' }
    }
    const consumerSession = args.sessionForConsumers
      ? await waitForAiVaultScan(args.sessionForConsumers(session), args.signal)
      : session
    throwIfAiVaultScanCancelled(args.signal)
    channel.finishRead({
      session: consumerSession,
      byteOffset: coveredThrough ?? readResult.consumedThrough,
      incomplete: false,
      prefixHash: readResult.prefixHash?.copy().digest('hex')
    })
    return {
      session,
      resume: {
        state,
        byteOffset: coveredThrough ?? readResult.consumedThrough,
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        channel,
        skippedRecords,
        prefixHash: readResult.prefixHash ?? null
      }
    }
  } catch (error) {
    channel.finishRead({
      session: null,
      byteOffset: startOffset,
      incomplete: true,
      cancelled:
        args.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    })
    throwIfAiVaultScanCancelled(args.signal)
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
    onSkippedRecords?: (records: SkippedTranscriptRecord[]) => void
  }
): Promise<AiVaultSession | null> {
  const { file } = args.candidate
  if (args.stats) {
    args.stats.fullParses++
    args.stats.bytesRead += file.sizeBytes ?? 0
  }
  const channel = new TranscriptMessageChannel()
  channel.beginRead({
    candidate: args.candidate,
    mode: 'replace',
    previousByteOffset: 0,
    indexing: args.indexing,
    signal: args.signal
  })
  try {
    const session = await parseAgentSessionFile(
      args.candidate,
      args.platform,
      channel,
      args.signal,
      args.onSkippedRecords
    )
    const consumerSession = args.sessionForConsumers
      ? await waitForAiVaultScan(args.sessionForConsumers(session), args.signal)
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
      cancelled:
        args.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    })
    throwIfAiVaultScanCancelled(args.signal)
    throw error
  }
}

function nonEmpty(offsets: ReadonlySet<number>): ReadonlySet<number> | undefined {
  return offsets.size > 0 ? offsets : undefined
}

// Heuristic: a growing rewrite can preserve this newline and evade detection until cache invalidation.
async function endsWithNewlineAt(
  path: string,
  offset: number,
  signal?: AbortSignal
): Promise<boolean> {
  const slice = await waitForAiVaultScan(
    readTranscriptSlice(path, offset - 1, 1, 'scan', signal),
    signal
  )
  return slice.length === 1 && slice[0] === NEWLINE_BYTE
}
