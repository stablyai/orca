import { protocol } from 'electron'
import type { Store } from '../persistence'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/media-file-extensions'
import {
  filePreviewForPath,
  isDocumentPreview,
  streamsPreviewByRange,
  type FilePreview
} from '../../shared/file-preview-kind'
import {
  assertLocalPreviewRasterHeader,
  assertPreviewableRasterHeader,
  assertRemotePreviewRasterHeader,
  incrementalPrefixReader
} from './preview-raster-header-check'
import {
  DOCUMENT_SIGNATURE_PROBE_BYTES,
  prefixFitsDocumentPreview
} from './preview-document-signature'
import { openLocalPreviewGrantFile } from './local-preview-grant-file'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { openLocalRegularFile } from '../ipc/filesystem/local-regular-file-read'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { createMediaRangeResponse } from './media-range-response'
import {
  REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE,
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewChunk,
  readRemotePreviewRange,
  statRemotePreviewFile,
  type RemotePreviewFileSnapshot
} from './remote-file-preview-reader'
import { readRegisteredPairingRevision } from '../ipc/runtime-environments/runtime-environment-registry-root'
import {
  grants,
  mintPreviewUrl,
  remoteSnapshot,
  revokeGrant,
  type LocalPreviewTarget,
  type PreviewGrant,
  type PreviewSender,
  type PreviewUrl
} from './preview-grant-registry'

export { revokeRemoteFilePreviewGrants } from './preview-grant-registry'

export const MEDIA_PREVIEW_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: MEDIA_PREVIEW_SCHEME,
  // No fetch or CORS: only <img>/<video>/<audio> elements load these URLs; PDF ranges go over IPC.
  privileges: { standard: true, secure: true, stream: true }
}

/**
 * A local file as an `orca-media://` URL its viewer reads by range: audio and video always,
 * images and PDFs only for a viewer that asks (`documents`); other callers keep base64.
 */
export async function readLocalFilePreview(
  event: { sender: PreviewSender },
  target: LocalPreviewTarget,
  store: Store,
  options: { documents: boolean }
): Promise<PreviewUrl | null> {
  const named = filePreviewForPath(target.filePath)
  if (!named) {
    return null
  }
  if (streamsPreviewByRange(named)) {
    return mintPreviewUrl(event.sender, target, store, named)
  }
  if (!options.documents || target.connectionId) {
    return null
  }
  const lifetime = abortWhenRendererGone(event.sender)
  let preview: FilePreview
  let size: number
  try {
    const filePath = await resolveLocalFileRequestPath(target.filePath, target.access, store)
    // Classify the target, not the link: `shot.png -> drawing.svg` is an SVG, and base64 says so.
    const resolved = filePreviewForPath(filePath)
    if (!resolved || !isDocumentPreview(resolved)) {
      return null
    }
    preview = resolved
    const { handle, stats } = await openLocalRegularFile(filePath)
    try {
      await assertLocalPreviewRasterHeader(preview, handle, stats.size)
    } finally {
      await handle.close()
    }
    size = stats.size
    // A renderer gone mid-mint would leave a grant no teardown ever drops.
    lifetime.signal.throwIfAborted()
  } finally {
    lifetime.dispose()
  }
  return mintPreviewUrl(event.sender, target, store, preview, undefined, size)
}

/** A paired runtime's file as an `orca-media://` URL, streamed by range over files.stat/readChunk. */
export async function grantRemoteFilePreview(
  event: { sender: PreviewSender },
  address: RemoteFilePreviewAddress,
  store: Store
): Promise<PreviewUrl | null> {
  const preview = filePreviewForPath(address.relativePath)
  if (!preview) {
    return null
  }
  // Why: proving the file and range reads here makes a missing file or an old host fail in the tab, not as a silent player error.
  // An unpinned grant would follow a re-pair to another host; pin the pairing it was minted on.
  const pinned: RemoteFilePreviewAddress = {
    ...address,
    expectedEnvironmentPairingRevision:
      address.expectedEnvironmentPairingRevision ??
      readRegisteredPairingRevision(address.environmentId)
  }
  const lifetime = abortWhenRendererGone(event.sender)
  let snapshot: RemotePreviewFileSnapshot
  try {
    snapshot = await statRemotePreviewFile(pinned, lifetime.signal)
    if (snapshot.size > 0) {
      await assertRemoteChunkReadsSupported(pinned, lifetime.signal)
    }
  } catch (error) {
    lifetime.dispose()
    // An older host still previews images and PDFs whole through files.readPreview.
    if (
      isDocumentPreview(preview) &&
      error instanceof Error &&
      error.message === REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE
    ) {
      return null
    }
    throw error
  }
  try {
    const readPrefix = incrementalPrefixReader((offset, length) =>
      readRemotePreviewRange(pinned, offset, length, snapshot.size, lifetime.signal)
    )
    // files.stat names no link target, but the host's readPreview classifies it; defer on a mislabel.
    if (
      isDocumentPreview(preview) &&
      !prefixFitsDocumentPreview(preview, await readPrefix(DOCUMENT_SIGNATURE_PROBE_BYTES))
    ) {
      return null
    }
    await assertPreviewableRasterHeader(preview, readPrefix, snapshot.size)
    // A renderer gone mid-mint would leave a grant no teardown ever drops.
    lifetime.signal.throwIfAborted()
  } finally {
    lifetime.dispose()
  }
  return mintPreviewUrl(event.sender, { remote: pinned }, store, preview, snapshot)
}

async function handleRemotePreviewRequest(
  request: Request,
  token: string,
  grant: PreviewGrant,
  remote: RemoteFilePreviewAddress
): Promise<Response> {
  // Electron's request.signal may never abort; close() also cancels the in-flight chunk.
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (request.signal.aborted) {
    forwardAbort()
  } else {
    request.signal.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    // Re-stat (at most once a second) like a local file re-opens per request, so a growing recording keeps playing.
    const { size } = await remoteSnapshot(grant, remote)
    // The file can change after mint; check the bytes this response serves.
    await assertRemotePreviewRasterHeader(grant.preview, remote, size, controller.signal)
    return await createMediaRangeResponse(request, grant.mimeType, {
      size,
      read: (offset, length) => readRemotePreviewChunk(remote, offset, length, controller.signal),
      close: async () => {
        request.signal.removeEventListener('abort', forwardAbort)
        controller.abort()
      }
    })
  } catch (error) {
    request.signal.removeEventListener('abort', forwardAbort)
    if (error instanceof RemotePreviewPairingChangedError) {
      revokeGrant(token)
      return new Response(null, { status: 410 })
    }
    // A lost server is not "file missing".
    return new Response(null, { status: 502 })
  }
}

export async function handleMediaPreviewRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const token = url.hostname === 'file' ? url.pathname.slice(1) : ''
  const grant = grants.get(token)
  if (!grant) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }
  const { target, store, mimeType } = grant
  if ('remote' in target) {
    return handleRemotePreviewRequest(request, token, grant, target.remote)
  }
  try {
    // This process cannot serve SSH filesystems.
    if (target.connectionId) {
      return new Response(null, { status: 404 })
    }
    const { handle, stats } = await openLocalPreviewGrantFile(grant, target, store)
    try {
      // The file can change after mint; check the handle this response serves.
      await assertLocalPreviewRasterHeader(grant.preview, handle, stats.size)
    } catch (error) {
      await handle.close()
      throw error
    }
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
