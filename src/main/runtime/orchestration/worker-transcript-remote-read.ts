import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadFallbackReason } from '../../../shared/orchestration-worker-output'
import { FileRangeReadUnsupportedError, type IFilesystemProvider } from '../../providers/types'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from '../../native-chat/transcript-tail-reader'
import { transcriptFallbackId } from '../../native-chat/transcript-fallback-id'
import { sshFileStreamReadCap } from '../../ssh/ssh-file-stream-read-cap'
import {
  boundWorkerTranscriptMessages,
  clampWorkerTranscriptLimit
} from './worker-transcript-payload'
import {
  createWorkerTranscriptBoundaryCheckpoint,
  remoteWorkerTranscriptSourceIdentity,
  WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES,
  workerTranscriptSourceChanged
} from './worker-transcript-source-identity'
import {
  readRemoteTranscriptRangedWindow,
  supportsRemoteTranscriptRangeRead,
  type RemoteTranscriptWindow
} from './worker-transcript-remote-range-read'

export const MAX_REMOTE_TRANSCRIPT_SCAN_BYTES = 8 * 1024 * 1024
// The legacy snapshot stays at SSH's established ceiling while parsing only the scan window.
const MAX_LEGACY_REMOTE_TRANSCRIPT_READ_BYTES = sshFileStreamReadCap(false)

type RemoteReadArgs = {
  agent: string
  sessionId: string
  transcriptPath?: string
  offset?: number
  limit?: number
  expectedBoundaryCheckpoint?: string
  filesystemProvider?: IFilesystemProvider
}

type RemoteReadResult =
  | {
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
  | {
      ok: false
      reason: OrchestrationWorkerReadFallbackReason | 'source_changed'
      warnings: string[]
    }

class RemoteTranscriptIdentityUnavailableError extends Error {}

export async function readRemoteWorkerTranscript(
  args: RemoteReadArgs,
  filePath: string,
  decode: NativeChatLineDecoder
): Promise<RemoteReadResult> {
  try {
    const window = await readTranscriptWindow(args, filePath)
    if (!window) {
      return { ok: false, reason: 'source_changed', warnings: [] }
    }
    return parseTranscriptWindow(args, filePath, decode, window)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'transcript_missing' : 'remote_capability_unavailable',
      warnings: []
    }
  }
}

async function readTranscriptWindow(
  args: RemoteReadArgs,
  filePath: string
): Promise<RemoteTranscriptWindow | null> {
  const provider = args.filesystemProvider!
  if (await supportsRemoteTranscriptRangeRead(provider)) {
    try {
      return await readRemoteTranscriptRangedWindow({
        provider,
        filePath,
        requestedOffset: args.offset,
        expectedBoundaryCheckpoint: args.expectedBoundaryCheckpoint,
        maxScanBytes: MAX_REMOTE_TRANSCRIPT_SCAN_BYTES
      })
    } catch (error) {
      // A stale capability answer can race an older relay; degrade once through its bounded snapshot.
      if (!(error instanceof FileRangeReadUnsupportedError)) {
        throw error
      }
    }
  }
  return readLegacyWindow(provider, filePath, args.offset, args.expectedBoundaryCheckpoint)
}

async function readLegacyWindow(
  provider: IFilesystemProvider,
  filePath: string,
  requestedOffset: number | undefined,
  expectedBoundaryCheckpoint: string | undefined
): Promise<RemoteTranscriptWindow | null> {
  const sourceIdentity = remoteWorkerTranscriptSourceIdentity(await provider.stat(filePath))
  if (!sourceIdentity) {
    throw new RemoteTranscriptIdentityUnavailableError(
      'Remote transcript host did not provide stable file identity'
    )
  }
  const result = await provider.readFile(filePath, {
    maxTextBytes: MAX_LEGACY_REMOTE_TRANSCRIPT_READ_BYTES
  })
  if (typeof result.content !== 'string') {
    throw new Error('Remote transcript read returned invalid content')
  }
  const allBytes = Buffer.from(result.content, 'utf8')
  const fileSize = allBytes.length
  const startOffset = requestedOffset ?? Math.max(0, fileSize - MAX_REMOTE_TRANSCRIPT_SCAN_BYTES)
  if (startOffset > fileSize) {
    return null
  }
  const scanEnd = Math.min(fileSize, startOffset + MAX_REMOTE_TRANSCRIPT_SCAN_BYTES)
  const boundaryStart = Math.max(0, startOffset - WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES)
  const boundaryPrefix = allBytes.subarray(boundaryStart, startOffset)
  if (
    expectedBoundaryCheckpoint !== undefined &&
    createWorkerTranscriptBoundaryCheckpoint(boundaryPrefix) !== expectedBoundaryCheckpoint
  ) {
    return null
  }
  const after = remoteWorkerTranscriptSourceIdentity(await provider.stat(filePath))
  if (workerTranscriptSourceChanged(sourceIdentity, after, scanEnd)) {
    return null
  }
  return {
    bytes: allBytes.subarray(startOffset, scanEnd),
    fileSize,
    startOffset,
    scanEnd,
    startsInsideRecord: startOffset > 0 && allBytes[startOffset - 1] !== 0x0a,
    boundaryPrefix,
    sourceIdentity
  }
}

function parseTranscriptWindow(
  args: RemoteReadArgs,
  filePath: string,
  decode: NativeChatLineDecoder,
  window: RemoteTranscriptWindow
): RemoteReadResult {
  const limit = clampWorkerTranscriptLimit(args.limit)
  const initialRead = args.offset === undefined
  const messages: NativeChatMessage[] = []
  const decodedMessages: NativeChatMessage[] = []
  let malformed = 0
  let oversized = 0
  let relativeCursor = 0
  let nextOffset = window.startOffset
  if (window.startsInsideRecord) {
    const newline = window.bytes.indexOf(0x0a)
    if (newline === -1) {
      return finish(window.scanEnd < window.fileSize ? window.scanEnd : window.startOffset)
    }
    relativeCursor = newline + 1
    nextOffset = window.startOffset + relativeCursor
  }
  while (relativeCursor < window.bytes.length && (initialRead || messages.length < limit)) {
    const newline = window.bytes.indexOf(0x0a, relativeCursor)
    if (newline === -1) {
      if (window.scanEnd < window.fileSize) {
        if (window.bytes.length - relativeCursor > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
          oversized++
          nextOffset = window.scanEnd
        }
      }
      break
    }
    const lineEnd = newline + 1
    const line = window.bytes
      .subarray(relativeCursor, lineEnd)
      .toString('utf8')
      .replace(/\r?\n$/, '')
    if (Buffer.byteLength(line, 'utf8') > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      oversized++
    } else if (line) {
      try {
        JSON.parse(line)
        const absoluteLineStart = window.startOffset + relativeCursor
        const message = decode(line, transcriptFallbackId(filePath, absoluteLineStart))
        if (message) {
          const destination = initialRead ? decodedMessages : messages
          destination.push(message)
        }
      } catch {
        malformed++
      }
    }
    relativeCursor = lineEnd
    nextOffset = window.startOffset + relativeCursor
  }
  if (initialRead) {
    messages.push(...decodedMessages.slice(-limit))
  }
  return finish(nextOffset)

  function finish(cursor: number): RemoteReadResult {
    const bounded = boundWorkerTranscriptMessages(messages, filePath)
    const scanLimited = window.startOffset > 0 || window.scanEnd < window.fileSize
    const initialTailClipped = initialRead && window.startOffset > 0
    const pageLimited = initialRead
      ? scanLimited || decodedMessages.length > limit
      : cursor < window.fileSize
    return {
      ok: true,
      filePath,
      sourceFingerprint: window.sourceIdentity.fingerprint,
      boundaryCheckpoint: boundaryCheckpointAt(window, cursor),
      messages: bounded.messages,
      nextOffset: cursor,
      limited: bounded.limited || pageLimited,
      clipping: [
        ...(pageLimited ? ['message_limit_or_scan_window'] : []),
        ...(bounded.limited ? ['transcript_payload'] : [])
      ],
      warnings: [
        ...(malformed > 0 ? [`${malformed} malformed transcript record(s) were skipped.`] : []),
        ...(oversized > 0 ? [`${oversized} oversized transcript record(s) were skipped.`] : []),
        ...bounded.warnings,
        ...(initialTailClipped
          ? [
              'Older transcript records were clipped by the remote scan limit and are not pageable through this EOF cursor; the cursor only follows records appended after this read.'
            ]
          : scanLimited
            ? ['Transcript scanning stopped at the bounded byte limit; continue with the cursor.']
            : [])
      ]
    }
  }
}

function boundaryCheckpointAt(window: RemoteTranscriptWindow, offset: number): string {
  const relativeOffset = offset - window.startOffset
  if (relativeOffset >= WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES) {
    return createWorkerTranscriptBoundaryCheckpoint(
      window.bytes.subarray(
        relativeOffset - WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES,
        relativeOffset
      )
    )
  }
  const prefixBytes = Math.min(
    window.boundaryPrefix.length,
    WORKER_TRANSCRIPT_BOUNDARY_CHECKPOINT_BYTES - relativeOffset
  )
  return createWorkerTranscriptBoundaryCheckpoint(
    Buffer.concat([
      window.boundaryPrefix.subarray(window.boundaryPrefix.length - prefixBytes),
      window.bytes.subarray(0, relativeOffset)
    ])
  )
}
