import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/media-file-extensions'
import { isDocumentPreview, type FilePreview } from '../../shared/file-preview-kind'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import {
  RemotePreviewGrantLapsedError,
  renewRemotePreviewGrant,
  statRemotePreviewFile,
  type GrantedRemoteFilePreviewAddress,
  type RemotePreviewFileSnapshot
} from './remote-file-preview-reader'

export type LocalPreviewTarget = {
  filePath: string
  connectionId?: string
  access?: LocalFileAccess
}
export type RemotePreviewTarget = { remote: RemoteFilePreviewAddress }
export type PreviewTarget = LocalPreviewTarget | RemotePreviewTarget
export type PreviewGrant = {
  target: PreviewTarget
  store: Store
  preview: FilePreview
  mimeType: string
  senderId: number
  key: string
  // Why: a seek or prefetch burst opens several ranges at once; one stat answers all of them.
  stat?: { at: number; snapshot: Promise<RemotePreviewFileSnapshot> }
  // Why: likewise one renewal answers a burst that found a granted file's grant lapsed.
  renewal?: Promise<RemoteFilePreviewAddress>
}
export type PreviewUrl = {
  content: string
  isBinary: true
  mimeType: string
  mediaUrl: string
  // Images and PDFs: the editor's selector for its document viewers, as base64 previews set it.
  isImage?: true
  size?: number
}

const REMOTE_STAT_REUSE_MS = 1_000
export const grants = new Map<string, PreviewGrant>()
const senders = new Map<number, Map<string, string>>()

export type PreviewSender = Pick<WebContents, 'id' | 'on' | 'removeListener'>

export function mintPreviewUrl(
  sender: PreviewSender,
  target: PreviewTarget,
  store: Store,
  preview: FilePreview,
  snapshot?: RemotePreviewFileSnapshot,
  size?: number
): PreviewUrl {
  const { mimeType } = preview
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
  // A retargeted link re-mints as its new kind, never as the old grant's type.
  const key = JSON.stringify([target, mimeType])
  let token = owned.get(key)
  if (!token || !grants.has(token)) {
    token = randomUUID()
    owned.set(key, token)
    grants.set(token, { target, store, preview, mimeType, senderId: sender.id, key })
  }
  const grant = grants.get(token)
  if (grant && snapshot) {
    // A reload re-mints the same token; its fresh stat must replace a cached older size.
    grant.stat = { at: Date.now(), snapshot: Promise.resolve(snapshot) }
  }
  const byteSize = snapshot?.size ?? size
  return {
    content: '',
    isBinary: true,
    mimeType,
    mediaUrl: `${MEDIA_PREVIEW_SCHEME}://file/${token}?revision=${randomUUID()}`,
    ...(isDocumentPreview(preview) ? { isImage: true as const } : {}),
    ...(byteSize !== undefined ? { size: byteSize } : {})
  }
}

export function revokeGrant(token: string): void {
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

/** Removing a paired runtime ends every preview it backs. */
export function revokeRemoteFilePreviewGrants(environmentId: string): void {
  for (const [token, grant] of grants) {
    if ('remote' in grant.target && grant.target.remote.environmentId === environmentId) {
      revokeGrant(token)
    }
  }
}

export function remoteSnapshot(grant: PreviewGrant): Promise<RemotePreviewFileSnapshot> {
  const now = Date.now()
  if (!grant.stat || now - grant.stat.at > REMOTE_STAT_REUSE_MS) {
    // Not tied to one request's abort: other ranges in the burst may be waiting on it.
    const signal = new AbortController().signal
    const snapshot = callRemotePreview(grant, (remote) => statRemotePreviewFile(remote, signal))
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

/** The grant behind an orca-media URL, only for the renderer that minted it. */
export function previewGrantForSender(
  url: string,
  senderId: number
): { token: string; grant: PreviewGrant } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const token =
    parsed.protocol === `${MEDIA_PREVIEW_SCHEME}:` && parsed.hostname === 'file'
      ? parsed.pathname.slice(1)
      : ''
  const grant = grants.get(token)
  return grant && grant.senderId === senderId ? { token, grant } : null
}

/**
 * Runs one host call for a remote preview on its current address. A paused or reconnected viewer
 * outlives its grant, so a lapsed one is renewed once, as the editor's reads do, wherever the call
 * happens: a stat, a streamed chunk or a PDF range.
 */
export async function callRemotePreview<T>(
  grant: PreviewGrant,
  call: (remote: RemoteFilePreviewAddress) => Promise<T>
): Promise<T> {
  if (!('remote' in grant.target)) {
    throw new Error('Preview is not a remote file')
  }
  const remote = grant.target.remote
  try {
    return await call(remote)
  } catch (error) {
    if (!(error instanceof RemotePreviewGrantLapsedError) || remote.grantId === undefined) {
      throw error
    }
    return call(await renewedRemoteTarget(grant, remote))
  }
}

/** The preview's address under a fresh grant, shared by every request that found the old one lapsed. */
function renewedRemoteTarget(
  grant: PreviewGrant,
  lapsed: GrantedRemoteFilePreviewAddress
): Promise<RemoteFilePreviewAddress> {
  const current = 'remote' in grant.target ? grant.target.remote : null
  if (current && current.grantId !== lapsed.grantId) {
    return Promise.resolve(current)
  }
  if (!grant.renewal) {
    const renewal: Promise<RemoteFilePreviewAddress> = renewRemotePreviewGrant(
      lapsed,
      new AbortController().signal
    )
      .then((remote) => {
        grant.target = { remote }
        grant.stat = undefined
        return remote
      })
      .finally(() => {
        if (grant.renewal === renewal) {
          grant.renewal = undefined
        }
      })
    grant.renewal = renewal
  }
  return grant.renewal
}
