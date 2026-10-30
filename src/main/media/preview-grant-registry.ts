import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type { LocalFileAccess } from '../../shared/local-file-access'
import { MEDIA_PREVIEW_SCHEME } from '../../shared/media-file-extensions'
import { isDocumentPreview, type FilePreview } from '../../shared/file-preview-kind'
import type { RemoteFilePreviewAddress } from '../../shared/remote-file-preview-address'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { statRemotePreviewFile, type RemotePreviewFileSnapshot } from './remote-file-preview-reader'

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

export function remoteSnapshot(grant: PreviewGrant, remote: RemoteFilePreviewAddress) {
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
