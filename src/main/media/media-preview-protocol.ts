import { randomUUID } from 'node:crypto'
import { protocol, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/media-file-extensions'
import { filePreviewForPath, streamsPreviewByRange } from '../../shared/file-preview-kind'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import { resolveLocalFileRequestPath } from '../ipc/local-file-access-resolution'
import { openLocalRegularFile } from '../ipc/filesystem/local-regular-file-read'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { createMediaRangeResponse } from './media-range-response'
import {
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewChunk,
  statRemotePreviewFile,
  type RemotePreviewFileSnapshot
} from './remote-file-preview-reader'
import { readRegisteredPairingRevision } from '../ipc/runtime-environments/runtime-environment-registry-root'

type LocalPreviewTarget = { filePath: string; connectionId?: string; access?: LocalFileAccess }
type RemotePreviewTarget = { remote: RemoteFilePreviewAddress }
type PreviewTarget = LocalPreviewTarget | RemotePreviewTarget
type PreviewGrant = {
  target: PreviewTarget
  store: Store
  mimeType: string
  senderId: number
  key: string
  // Why: a seek or prefetch burst opens several ranges at once; one stat answers all of them.
  stat?: { at: number; snapshot: Promise<RemotePreviewFileSnapshot> }
}
type PreviewUrl = { content: string; isBinary: true; mimeType: string; mediaUrl: string }

const REMOTE_STAT_REUSE_MS = 1_000
const grants = new Map<string, PreviewGrant>()
const senders = new Map<number, Map<string, string>>()

export const MEDIA_PREVIEW_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: MEDIA_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, stream: true }
}

type PreviewSender = Pick<WebContents, 'id' | 'on' | 'removeListener'>

function mintPreviewUrl(
  sender: PreviewSender,
  target: PreviewTarget,
  store: Store,
  mimeType: string,
  snapshot?: RemotePreviewFileSnapshot
): PreviewUrl {
  let owned = senders.get(sender.id)
  if (!owned) {
    owned = new Map()
    senders.set(sender.id, owned)
    const lifetime = abortWhenRendererGone(sender)
    const entries = owned
    lifetime.signal.addEventListener(
      'abort',
      () => {
        for (const token of entries.values()) {
          grants.delete(token)
        }
        senders.delete(sender.id)
        lifetime.dispose()
      },
      { once: true }
    )
  }
  const key = JSON.stringify(target)
  let token = owned.get(key)
  if (!token || !grants.has(token)) {
    token = randomUUID()
    owned.set(key, token)
    grants.set(token, { target, store, mimeType, senderId: sender.id, key })
  }
  const grant = grants.get(token)
  if (grant && snapshot) {
    // A reload re-mints the same token; its fresh stat must replace a cached older size.
    grant.stat = { at: Date.now(), snapshot: Promise.resolve(snapshot) }
  }
  return {
    content: '',
    isBinary: true,
    mimeType,
    mediaUrl: `${MEDIA_PREVIEW_SCHEME}://file/${token}?revision=${randomUUID()}`
  }
}

function revokeGrant(token: string): void {
  const grant = grants.get(token)
  if (!grant) {
    return
  }
  grants.delete(token)
  const owned = senders.get(grant.senderId)
  if (owned?.get(grant.key) === token) {
    owned.delete(grant.key)
  }
}

/** A local audio/video file as an `orca-media://` URL its viewer streams by range. */
export function readMediaPreview(
  event: { sender: PreviewSender },
  target: LocalPreviewTarget,
  store: Store
): PreviewUrl | null {
  const preview = filePreviewForPath(target.filePath)
  if (!preview || !streamsPreviewByRange(preview)) {
    return null
  }
  return mintPreviewUrl(event.sender, target, store, preview.mimeType)
}

/** A paired runtime's file as an `orca-media://` URL, streamed by range over files.stat/readChunk. */
export async function grantRemoteFilePreview(
  event: { sender: PreviewSender },
  address: RemoteFilePreviewAddress,
  store: Store
): Promise<PreviewUrl | null> {
  const preview = filePreviewForPath(address.relativePath)
  if (!preview || !streamsPreviewByRange(preview)) {
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
    // A renderer gone mid-mint would leave a grant no teardown ever drops.
    lifetime.signal.throwIfAborted()
  } finally {
    lifetime.dispose()
  }
  return mintPreviewUrl(event.sender, { remote: pinned }, store, preview.mimeType, snapshot)
}

/** Removing a paired runtime ends every preview it backs. */
export function revokeRemoteFilePreviewGrants(environmentId: string): void {
  for (const [token, grant] of grants) {
    if ('remote' in grant.target && grant.target.remote.environmentId === environmentId) {
      revokeGrant(token)
    }
  }
}

function remoteSnapshot(grant: PreviewGrant, remote: RemoteFilePreviewAddress) {
  const now = Date.now()
  if (!grant.stat || now - grant.stat.at > REMOTE_STAT_REUSE_MS) {
    // Not tied to one request's abort: other ranges in the burst may be waiting on it.
    const snapshot = statRemotePreviewFile(remote, new AbortController().signal)
    const stat = { at: now, snapshot }
    grant.stat = stat
    snapshot.catch(() => {
      if (grant.stat === stat) {
        grant.stat = undefined
      }
    })
  }
  return grant.stat.snapshot
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
