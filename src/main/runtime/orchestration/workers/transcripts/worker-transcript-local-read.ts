import { open } from 'node:fs/promises'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from '../../../../native-chat/transcript-tail-reader'
import { TAIL_CHUNK_BYTES } from '../../../../native-chat/transcript-watching/transcript-tail-boundary'
import type { NativeChatTurnEvidence } from '../../../../native-chat/transcript-decoding/transcript-turn-evidence'
import { transcriptFallbackId } from '../../../../native-chat/transcript-streaming/transcript-fallback-id'
import {
  localTranscriptOffsetStartsInsideRecord,
  readLocalTranscriptHandleBoundaryCheckpoint,
  readLocalTranscriptSourceIdentity
} from './worker-transcript-local-checkpoint'
import {
  localWorkerTranscriptSourceIdentity,
  workerTranscriptSourceChanged,
  type WorkerTranscriptSourceIdentity
} from './worker-transcript-source-identity'

// At least one accepted record (MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) with its line end.
export const MAX_TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024

type LocalTranscriptReadSuccess = {
  ok: true
  filePath: string
  sourceFingerprint: string
  boundaryCheckpoint: string
  messages: NativeChatMessage[]
  nextOffset: number
  limited: boolean
  clipping: string[]
  warnings: string[]
  /** An initial page's newest turn marker, from the bytes it decoded. */
  turn?: NativeChatTurnEvidence
  /** A tail page's backward boundary: where the next older page ends, or null at the file start. */
  older?: WorkerTranscriptOlderBoundary | null
}

/** Where a backward page ends: normally the start of the oldest message the newer page kept;
 *  `insideRecord` when the newer window held no line start, so the offset is inside a record
 *  too long to read, whose start is further back. Plus the hash of the bytes before it. */
export type WorkerTranscriptOlderBoundary = {
  offset: number
  insideRecord?: true
  boundaryCheckpoint: string
}

type LocalTranscriptPage = Omit<LocalTranscriptReadSuccess, 'boundaryCheckpoint'>

export type LocalTranscriptReadResult =
  | { ok: false; reason: 'source_changed' | 'transcript_unreadable'; warnings: string[] }
  | LocalTranscriptReadSuccess

export async function readForwardLocalWorkerTranscriptPage(
  filePath: string,
  startOffset: number,
  limit: number,
  decode: NativeChatLineDecoder,
  expectedBoundaryCheckpoint: string | undefined,
  /** How many of a page's leading messages fit its response; the cursor resumes after the last one. */
  fits: (messages: readonly NativeChatMessage[]) => number
): Promise<LocalTranscriptReadResult> {
  const sourceIdentity = await readLocalTranscriptSourceIdentity(filePath)
  if (!sourceIdentity) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const fileSize = sourceIdentity.size
  if (startOffset > fileSize) {
    return sourceChanged()
  }
  const scanEnd = Math.min(fileSize, startOffset + MAX_TRANSCRIPT_SCAN_BYTES)
  const handle = await open(filePath, 'r')
  const opened = localWorkerTranscriptSourceIdentity(await handle.stat({ bigint: true }))
  if (!opened || opened.fingerprint !== sourceIdentity.fingerprint || opened.size < scanEnd) {
    await handle.close()
    return sourceChanged()
  }
  try {
    const beforeCheckpoint = await readLocalTranscriptHandleBoundaryCheckpoint(handle, startOffset)
    if (
      !beforeCheckpoint ||
      (expectedBoundaryCheckpoint !== undefined && beforeCheckpoint !== expectedBoundaryCheckpoint)
    ) {
      return sourceChanged()
    }
    const page =
      startOffset === fileSize
        ? emptyPage(filePath, sourceIdentity.fingerprint, startOffset)
        : await scanForwardPage({
            handle,
            filePath,
            sourceIdentity,
            startOffset,
            scanEnd,
            fileSize,
            limit,
            decode,
            fits
          })
    const afterCheckpoint = await readLocalTranscriptHandleBoundaryCheckpoint(handle, startOffset)
    const boundaryCheckpoint = await readLocalTranscriptHandleBoundaryCheckpoint(
      handle,
      page.nextOffset
    )
    const handleAfter = localWorkerTranscriptSourceIdentity(await handle.stat({ bigint: true }))
    const pathAfter = await readLocalTranscriptSourceIdentity(filePath)
    const minimumSize = page.nextOffset
    return !afterCheckpoint ||
      (expectedBoundaryCheckpoint !== undefined &&
        afterCheckpoint !== expectedBoundaryCheckpoint) ||
      !boundaryCheckpoint ||
      workerTranscriptSourceChanged(sourceIdentity, handleAfter, minimumSize) ||
      workerTranscriptSourceChanged(sourceIdentity, pathAfter, minimumSize)
      ? sourceChanged()
      : { ...page, boundaryCheckpoint }
  } finally {
    await handle.close()
  }
}

async function scanForwardPage(args: {
  handle: Awaited<ReturnType<typeof open>>
  filePath: string
  sourceIdentity: WorkerTranscriptSourceIdentity
  startOffset: number
  scanEnd: number
  fileSize: number
  limit: number
  decode: NativeChatLineDecoder
  fits: (messages: readonly NativeChatMessage[]) => number
}): Promise<LocalTranscriptPage> {
  const messages: NativeChatMessage[] = []
  const messageEnds: number[] = []
  let pendingChunks: Buffer[] = []
  let pendingBytes = 0
  let pendingStart = args.startOffset
  let droppingOversizedRecord = await localTranscriptOffsetStartsInsideRecord(
    args.handle,
    args.startOffset
  )
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let nextOffset = args.startOffset
  let absoluteOffset = args.startOffset
  // Positional reads keep the shared handle open for the boundary checks after an early return.
  while (absoluteOffset < args.scanEnd) {
    const buffer = Buffer.allocUnsafe(Math.min(TAIL_CHUNK_BYTES, args.scanEnd - absoluteOffset))
    const { bytesRead } = await args.handle.read(buffer, 0, buffer.length, absoluteOffset)
    if (bytesRead === 0) {
      break
    }
    const chunk = buffer.subarray(0, bytesRead)
    let segmentStart = 0
    let newline = chunk.indexOf(0x0a)
    while (newline >= 0) {
      retainPart(chunk.subarray(segmentStart, newline))
      const lineEnd = absoluteOffset + newline + 1
      if (!droppingOversizedRecord) {
        decodeLine(lineEnd)
      }
      resetLine(lineEnd)
      nextOffset = lineEnd
      if (messages.length >= args.limit) {
        return successfulPage(lineEnd < args.fileSize)
      }
      segmentStart = newline + 1
      newline = chunk.indexOf(0x0a, segmentStart)
    }
    if (segmentStart < chunk.length) {
      retainPart(chunk.subarray(segmentStart))
    }
    absoluteOffset += chunk.length
  }
  if (droppingOversizedRecord) {
    nextOffset = args.scanEnd
  }
  return successfulPage(args.scanEnd < args.fileSize, args.scanEnd < args.fileSize)

  function retainPart(part: Buffer): void {
    if (droppingOversizedRecord) {
      return
    }
    pendingBytes += part.length
    if (pendingBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      pendingChunks = []
      droppingOversizedRecord = true
      oversizedRecordCount++
      return
    }
    pendingChunks.push(part)
  }

  function resetLine(nextStart: number): void {
    pendingChunks = []
    pendingBytes = 0
    droppingOversizedRecord = false
    pendingStart = nextStart
  }

  function decodeLine(lineEnd: number): void {
    let line = Buffer.concat(pendingChunks).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return
    }
    try {
      JSON.parse(line)
    } catch {
      malformedRecordCount++
      return
    }
    const message = args.decode(line, transcriptFallbackId(args.filePath, pendingStart))
    if (message) {
      messages.push(message)
      messageEnds.push(lineEnd)
    }
  }

  function successfulPage(limited: boolean, scanLimited = false): LocalTranscriptPage {
    // Messages past the response budget are left for the next page, not skipped by the cursor.
    const kept = args.fits(messages)
    return {
      ok: true,
      filePath: args.filePath,
      sourceFingerprint: args.sourceIdentity.fingerprint,
      messages: messages.slice(0, kept),
      nextOffset: kept < messages.length ? messageEnds[kept - 1]! : nextOffset,
      limited: limited || kept < messages.length,
      clipping: [],
      warnings: recordWarnings(malformedRecordCount, oversizedRecordCount, scanLimited)
    }
  }
}

function emptyPage(
  filePath: string,
  sourceFingerprint: string,
  nextOffset: number
): LocalTranscriptPage {
  return {
    ok: true,
    filePath,
    sourceFingerprint,
    messages: [],
    nextOffset,
    limited: false,
    clipping: [],
    warnings: []
  }
}

export function sourceChanged(): Extract<LocalTranscriptReadResult, { ok: false }> {
  return { ok: false, reason: 'source_changed', warnings: [] }
}

export function recordWarnings(malformed = 0, oversized = 0, scanLimited = false): string[] {
  const warnings: string[] = []
  if (malformed > 0) {
    warnings.push(`${malformed} malformed transcript record(s) were skipped.`)
  }
  if (oversized > 0) {
    warnings.push(`${oversized} oversized transcript record(s) were skipped.`)
  }
  if (scanLimited) {
    warnings.push(
      'Transcript scanning stopped at the bounded byte limit; continue with the cursor.'
    )
  }
  return warnings
}
