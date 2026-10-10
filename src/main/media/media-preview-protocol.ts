import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { protocol, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { MEDIA_FILE_MIME_TYPES, MEDIA_PREVIEW_SCHEME } from '../../shared/media-file-extensions'
import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { openLocalRegularFile } from '../ipc/filesystem/local-regular-file-read'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { readSshFileExplorerChunk } from '../runtime/ssh-file-explorer-chunk-read'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { createMediaRangeResponse } from './media-range-response'

type MediaTarget = { filePath: string; connectionId?: string; access?: LocalFileAccess }
type MediaGrant = { target: MediaTarget; store: Store; mimeType: string }
const grants = new Map<string, MediaGrant>()
const senders = new Map<number, Map<string, string>>()

export const MEDIA_PREVIEW_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: MEDIA_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, stream: true }
}

export function readMediaPreview(
  event: { sender: Pick<WebContents, 'id' | 'once' | 'removeListener'> },
  target: MediaTarget,
  store: Store
): { content: string; isBinary: boolean; mimeType: string; mediaUrl: string } | null {
  const mimeType = MEDIA_FILE_MIME_TYPES[extname(target.filePath).toLowerCase()]
  if (!mimeType) {
    return null
  }
  let owned = senders.get(event.sender.id)
  if (!owned) {
    owned = new Map()
    senders.set(event.sender.id, owned)
    const lifetime = abortWhenRendererGone(event.sender)
    const entries = owned
    lifetime.signal.addEventListener(
      'abort',
      () => {
        for (const token of entries.values()) {
          grants.delete(token)
        }
        senders.delete(event.sender.id)
        lifetime.dispose()
      },
      { once: true }
    )
  }
  const key = JSON.stringify(target)
  let token = owned.get(key)
  if (!token) {
    token = randomUUID()
    owned.set(key, token)
    grants.set(token, { target, store, mimeType })
  }
  return {
    content: '',
    isBinary: true,
    mimeType,
    mediaUrl: `${MEDIA_PREVIEW_SCHEME}://file/${token}?revision=${randomUUID()}`
  }
}

export async function handleMediaPreviewRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const grant = url.hostname === 'file' ? grants.get(url.pathname.slice(1)) : undefined
  if (!grant) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }
  try {
    const { target, store, mimeType } = grant
    if (target.connectionId) {
      const provider = requireSshFilesystemProvider(target.connectionId)
      const stats = await provider.stat(target.filePath)
      if (stats.type !== 'file') {
        throw new Error('Not a regular file')
      }
      return await createMediaRangeResponse(request, mimeType, {
        size: stats.size,
        read: async (offset, length) => {
          const chunk = await readSshFileExplorerChunk(
            provider,
            target.filePath,
            stats.size,
            offset,
            length
          )
          return Buffer.from(chunk.contentBase64, 'base64')
        },
        close: async () => {}
      })
    }
    const filePath = await resolveLocalFileRequestPath(target.filePath, target.access, store)
    const { handle, stats } = await openLocalRegularFile(filePath)
    return await createMediaRangeResponse(request, mimeType, {
      size: stats.size,
      read: async (offset, length) => {
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        return buffer.subarray(0, bytesRead)
      },
      close: () => handle.close()
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

export function installMediaPreviewProtocolHandler(): void {
  protocol.handle(MEDIA_PREVIEW_SCHEME, handleMediaPreviewRequest)
}
