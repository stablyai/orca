import { open } from 'node:fs/promises'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from '../../native-chat/transcript-tail-reader'
import { transcriptFallbackId } from '../../native-chat/transcript-fallback-id'
import { MAX_REMOTE_TRANSCRIPT_SCAN_BYTES } from './worker-transcript-remote-read'
import {
  localTranscriptOffsetStartsInsideRecord,
  readLocalTranscriptHandleBoundaryCheckpoint,
  readLocalTranscriptPathBoundaryCheckpoint,
  readLocalTranscriptSourceIdentity
} from './worker-transcript-local-checkpoint'
import {
  localWorkerTranscriptSourceIdentity,
  workerTranscriptSourceChanged,
  type WorkerTranscriptSourceIdentity
} from './worker-transcript-source-identity'

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
}

type LocalTranscriptPage = Omit<LocalTranscriptReadSuccess, 'boundaryCheckpoint'>

type LocalTranscriptReadResult =
  | { ok: false; reason: 'source_changed' | 'transcript_unreadable'; warnings: string[] }
  | LocalTranscriptReadSuccess

export async function readInitialLocalWorkerTranscriptPage(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder
): Promise<LocalTranscriptReadResult> {
  const before = await readLocalTranscriptSourceIdentity(filePath)
  if (!before) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const page = await readNativeChatTranscriptTailFile(filePath, limit, decode, false)
  const after = await readLocalTranscriptSourceIdentity(filePath)
  if (workerTranscriptSourceChanged(before, after, page.consumedTo)) {
    return sourceChanged()
  }
  const boundaryCheckpoint = await readLocalTranscriptPathBoundaryCheckpoint(
    filePath,
    before,
    page.consumedTo
  )
  if (!boundaryCheckpoint) {
    return sourceChanged()
  }
  return {
    ok: true,
    filePath,
    sourceFingerprint: before.fingerprint,
    boundaryCheckpoint,
    messages: page.messages,
    nextOffset: page.consumedTo,
    limited: page.hasMore,
    clipping: [],
    warnings: recordWarnings(page.malformedRecordCount, page.oversizedRecordCount)
  }
}

export async function readForwardLocalWorkerTranscriptPage(
  filePath: string,
  startOffset: number,
  limit: number,
  decode: NativeChatLineDecoder,
  expectedBoundaryCheckpoint?: string
): Promise<LocalTranscriptReadResult> {
  const sourceIdentity = await readLocalTranscriptSourceIdentity(filePath)
  if (!sourceIdentity) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const fileSize = sourceIdentity.size
  if (startOffset > fileSize) {
    return sourceChanged()
  }
  const scanEnd = Math.min(fileSize, startOffset + MAX_REMOTE_TRANSCRIPT_SCAN_BYTES)
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
            decode
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
}): Promise<LocalTranscriptPage> {
  const messages: NativeChatMessage[] = []
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
  const stream = args.handle.createReadStream({
    start: args.startOffset,
    end: args.scanEnd - 1,
    autoClose: false
  })
  let absoluteOffset = args.startOffset
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    let segmentStart = 0
    let newline = chunk.indexOf(0x0a)
    while (newline >= 0) {
      retainPart(chunk.subarray(segmentStart, newline))
      const lineEnd = absoluteOffset + newline + 1
      if (!droppingOversizedRecord) {
        decodeLine()
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

  function decodeLine(): void {
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
    }
  }

  function successfulPage(limited: boolean, scanLimited = false): LocalTranscriptPage {
    return {
      ok: true,
      filePath: args.filePath,
      sourceFingerprint: args.sourceIdentity.fingerprint,
      messages,
      nextOffset,
      limited,
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

function sourceChanged(): Extract<LocalTranscriptReadResult, { ok: false }> {
  return { ok: false, reason: 'source_changed', warnings: [] }
}

function recordWarnings(malformed = 0, oversized = 0, scanLimited = false): string[] {
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
