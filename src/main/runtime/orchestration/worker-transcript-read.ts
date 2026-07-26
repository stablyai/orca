import { open, stat } from 'node:fs/promises'
import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import type { OrchestrationWorkerReadFallbackReason } from '../../../shared/orchestration-worker-output'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from '../../native-chat/transcript-tail-reader'
import { transcriptFallbackId } from '../../native-chat/transcript-fallback-id'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'

const MAX_FORWARD_TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024

type WorkerTranscriptReadFailure = {
  ok: false
  reason: OrchestrationWorkerReadFallbackReason | 'source_changed'
  warnings: string[]
}

type WorkerTranscriptReadSuccess = {
  ok: true
  filePath: string
  messages: NativeChatMessage[]
  nextOffset: number
  limited: boolean
  warnings: string[]
}

export type WorkerTranscriptReadResult = WorkerTranscriptReadFailure | WorkerTranscriptReadSuccess

export async function readWorkerTranscript(args: {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  offset?: number
  limit?: number
}): Promise<WorkerTranscriptReadResult> {
  const transcriptAgent = resolveNativeChatTranscriptAgent(args.agent)
  if (!transcriptAgent) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  const decode = nativeChatLineDecoderForAgent(args.agent)
  if (!decode) {
    return { ok: false, reason: 'provider_unsupported', warnings: [] }
  }
  let filePath: string | null
  try {
    filePath = await resolveSessionFilePath(args.agent, args.sessionId, {
      transcriptPath: args.transcriptPath
    })
  } catch {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  if (!filePath) {
    return { ok: false, reason: 'transcript_missing', warnings: [] }
  }
  const limit = clampWorkerTranscriptLimit(args.limit)
  try {
    const page =
      args.offset === undefined
        ? await readInitialPage(filePath, limit, decode)
        : await readForwardPage(filePath, args.offset, limit, decode)
    if (!page.ok) {
      return page
    }
    const bounded = boundWorkerTranscriptMessages(page.messages, filePath)
    return {
      ok: true,
      filePath,
      messages: bounded.messages,
      nextOffset: page.nextOffset,
      limited: page.limited || bounded.limited,
      warnings: [...page.warnings, ...bounded.warnings]
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason:
        code === 'ENOENT'
          ? 'transcript_missing'
          : code === 'EACCES' || code === 'EPERM'
            ? 'transcript_unreadable'
            : 'transcript_parse_failed',
      warnings: []
    }
  }
}

async function readInitialPage(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder
): Promise<WorkerTranscriptReadSuccess> {
  const page = await readNativeChatTranscriptTailFile(filePath, limit, decode, false)
  return {
    ok: true,
    filePath,
    messages: page.messages,
    nextOffset: page.consumedTo,
    limited: page.hasMore,
    warnings: recordWarnings(page.malformedRecordCount, page.oversizedRecordCount)
  }
}

async function readForwardPage(
  filePath: string,
  startOffset: number,
  limit: number,
  decode: NativeChatLineDecoder
): Promise<WorkerTranscriptReadResult> {
  const fileSize = (await stat(filePath)).size
  if (startOffset > fileSize) {
    return { ok: false, reason: 'source_changed', warnings: [] }
  }
  if (startOffset === fileSize) {
    return {
      ok: true,
      filePath,
      messages: [],
      nextOffset: startOffset,
      limited: false,
      warnings: []
    }
  }
  const scanEnd = Math.min(fileSize, startOffset + MAX_FORWARD_TRANSCRIPT_SCAN_BYTES)
  const handle = await open(filePath, 'r')
  const messages: NativeChatMessage[] = []
  let pendingChunks: Buffer[] = []
  let pendingBytes = 0
  let pendingStart = startOffset
  let droppingOversizedRecord = await startsInsideRecord(handle, startOffset)
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let nextOffset = startOffset
  try {
    const stream = handle.createReadStream({
      start: startOffset,
      end: scanEnd - 1,
      autoClose: false
    })
    let absoluteOffset = startOffset
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
        if (messages.length >= limit) {
          return successfulPage(lineEnd < fileSize)
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
      nextOffset = scanEnd
    }
    return successfulPage(scanEnd < fileSize, scanEnd < fileSize)
  } finally {
    await handle.close()
  }

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
    const message = decode(line, transcriptFallbackId(filePath, pendingStart))
    if (message) {
      messages.push(message)
    }
  }

  function successfulPage(limited: boolean, scanLimited = false): WorkerTranscriptReadSuccess {
    return {
      ok: true,
      filePath,
      messages,
      nextOffset,
      limited,
      warnings: recordWarnings(malformedRecordCount, oversizedRecordCount, scanLimited)
    }
  }
}

async function startsInsideRecord(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number
): Promise<boolean> {
  if (offset === 0) {
    return false
  }
  const previousByte = Buffer.allocUnsafe(1)
  const { bytesRead } = await handle.read(previousByte, 0, 1, offset - 1)
  return bytesRead === 1 && previousByte[0] !== 0x0a
}

function recordWarnings(
  malformedRecordCount = 0,
  oversizedRecordCount = 0,
  scanLimited = false
): string[] {
  const warnings: string[] = []
  if (malformedRecordCount > 0) {
    warnings.push(`${malformedRecordCount} malformed transcript record(s) were skipped.`)
  }
  if (oversizedRecordCount > 0) {
    warnings.push(`${oversizedRecordCount} oversized transcript record(s) were skipped.`)
  }
  if (scanLimited) {
    warnings.push(
      'Transcript scanning stopped at the bounded byte limit; continue with the cursor.'
    )
  }
  return warnings
}
