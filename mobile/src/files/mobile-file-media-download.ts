import { Buffer } from 'buffer/index.js'
import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import type { MobileFileMedia } from './mobile-file-media'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'

export const MOBILE_MEDIA_CHUNK_BYTES = 384 * 1024
export const MOBILE_MEDIA_MAX_BYTES = 256 * 1024 * 1024

const statRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.media-preview-stat',
    method: 'files.stat',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'media-file-stat',
      z.looseObject({
        size: z.number().int().nonnegative(),
        isDirectory: z.boolean(),
        mtime: z.number().finite(),
        ctime: z.number().finite().optional()
      })
    )
  })
)
const chunkRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.media-preview-chunk',
    method: 'files.readChunk',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'media-file-chunk',
      z.looseObject({
        contentBase64: z
          .string()
          .max((MOBILE_MEDIA_CHUNK_BYTES * 4) / 3)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        bytesRead: z.number().int().min(0).max(MOBILE_MEDIA_CHUNK_BYTES),
        eof: z.boolean()
      })
    )
  })
)

export type MobileMediaSink = {
  append(bytes: Uint8Array): void
  finish(): string
  dispose(): void
}

export async function downloadMobileFileMedia(
  client: MobileFilePreviewRpcSender,
  media: MobileFileMedia,
  sink: MobileMediaSink,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number) => void
): Promise<string> {
  const params = { worktree: `id:${media.worktreeId}`, relativePath: media.relativePath }
  const options = { failWhenDisconnected: true, timeoutMs: 30_000 }
  try {
    checkDownloadActive(signal)
    const statReply = await statRead.request(client, params, options)
    if (
      !statReply.ok &&
      isMobileMethodUnavailableError(statReply.error.code, statReply.error.message)
    ) {
      throw new Error('Update Orca on your desktop to preview media files on mobile')
    }
    const stat = statRead.interpret(statReply)
    checkDownloadActive(signal)
    if (stat.isDirectory || stat.size === 0) {
      throw new Error('This file has no playable media')
    }
    if (stat.size > MOBILE_MEDIA_MAX_BYTES) {
      throw new Error('Files larger than 256 MB cannot be previewed on mobile')
    }
    let offset = 0
    while (offset < stat.size) {
      checkDownloadActive(signal)
      const length = Math.min(MOBILE_MEDIA_CHUNK_BYTES, stat.size - offset)
      const chunk = chunkRead.interpret(
        await chunkRead.request(client, { ...params, offset, length }, options)
      )
      checkDownloadActive(signal)
      const bytes = Buffer.from(chunk.contentBase64, 'base64')
      if (
        bytes.byteLength !== chunk.bytesRead ||
        chunk.bytesRead === 0 ||
        chunk.bytesRead > length ||
        (chunk.eof && offset + chunk.bytesRead !== stat.size)
      ) {
        throw new Error('File changed during download. Retry the preview')
      }
      sink.append(bytes)
      offset += chunk.bytesRead
      onProgress(offset, stat.size)
    }
    const latest = statRead.interpret(await statRead.request(client, params, options))
    checkDownloadActive(signal)
    if (
      latest.isDirectory ||
      latest.size !== stat.size ||
      latest.mtime !== stat.mtime ||
      (stat.ctime !== undefined && latest.ctime !== stat.ctime)
    ) {
      throw new Error('File changed during download. Retry the preview')
    }
    return sink.finish()
  } catch (error) {
    sink.dispose()
    throw error
  }
}

function checkDownloadActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Media download cancelled')
  }
}
