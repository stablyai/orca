import type { RpcFailure } from '../transport/types'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { fileMediaChunkRead } from './mobile-file-preview-operations'

// The phone renders text, markdown, HTML and images itself; it has no PDF or video
// renderer, and the host refuses those binaries (`binary_file`). What the OS does
// open, this flow downloads chunk-by-chunk into the cache and hands off with the
// system share sheet — the mobile counterpart of the desktop's "open externally".

/** Documents and media Android/iOS can open from another app. */
export const MEDIA_HANDOFF_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav'
}

/** Host params cap one readChunk at 512KB (FileReadChunk), and replies stay far under budget. */
export const MEDIA_HANDOFF_CHUNK_BYTES = 512 * 1024

/** A cap the share sheet stays responsive under; larger files stay on the desktop. */
export const MEDIA_HANDOFF_MAX_BYTES = 128 * 1024 * 1024

export function mediaHandoffMimeFor(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  return MEDIA_HANDOFF_MIME_TYPES[base.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Where the downloaded bytes land. Kept behind a seam so the loop is testable without
 * expo-file-system, the way native-media splits its device calls out.
 */
export type MobileFileMediaSink = {
  /** Opens the destination fresh; any earlier download of the same name is discarded. */
  open(attempt: MobileFileMediaAttempt): void
  appendBase64(base64: string, attempt: MobileFileMediaAttempt): void
  /** Releases the active owner while retaining a completed file for sharing. */
  release(attempt: MobileFileMediaAttempt): void
  discard(attempt: MobileFileMediaAttempt): void
}

export type MobileFileMediaAttempt = {
  readonly cancelled: boolean
  cancel(): void
}

export function createMobileFileMediaAttempt(): MobileFileMediaAttempt {
  let cancelled = false
  return {
    get cancelled() {
      return cancelled
    },
    cancel() {
      cancelled = true
    }
  }
}

export type MobileFileMediaDownload = {
  byteLength: number
}

/** The bytes a base64 payload decodes to; padded groups are 1 or 2 bytes short of 3-per-4. */
export function mediaHandoffBase64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

export async function downloadMobileFileMedia(
  client: MobileFilePreviewRpcSender,
  args: { worktreeId: string; relativePath: string },
  sink: MobileFileMediaSink,
  onProgress?: (byteLength: number) => void,
  attempt: MobileFileMediaAttempt = createMobileFileMediaAttempt()
): Promise<MobileFileMediaDownload> {
  sink.open(attempt)
  let offset = 0
  let byteLength = 0
  let appendedBytes = 0
  try {
    for (;;) {
      if (attempt.cancelled) {
        throw new Error('Media download cancelled')
      }
      const reply = await fileMediaChunkRead.request(client, {
        worktree: `id:${args.worktreeId}`,
        relativePath: args.relativePath,
        offset,
        length: MEDIA_HANDOFF_CHUNK_BYTES
      })
      if (attempt.cancelled) {
        throw new Error('Media download cancelled')
      }
      const verdict = fileMediaChunkRead.interpret(reply)
      if (!verdict.accepted) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this policy skips only a refusal, so an unaccepted reply is a failure envelope.
        const refusal = (reply as RpcFailure).error
        throw new Error(refusal.message || refusal.code || 'Unable to open file')
      }
      const chunk = verdict.value
      if (chunk.bytesRead === 0) {
        break
      }
      // Why: the cap tracks the bytes we actually append — a host that under-reports bytesRead
      // must not slip a large file past it, and the crossing chunk must never reach the sink.
      const chunkBytes = mediaHandoffBase64ByteLength(chunk.contentBase64)
      if (appendedBytes + chunkBytes > MEDIA_HANDOFF_MAX_BYTES) {
        throw new Error('File too large to open on this device')
      }
      if (attempt.cancelled) {
        throw new Error('Media download cancelled')
      }
      sink.appendBase64(chunk.contentBase64, attempt)
      appendedBytes += chunkBytes
      byteLength += chunk.bytesRead
      offset += chunk.bytesRead
      onProgress?.(byteLength)
      if (chunk.eof) {
        break
      }
    }
  } catch (error) {
    sink.discard(attempt)
    throw error
  }
  sink.release(attempt)
  return { byteLength }
}
