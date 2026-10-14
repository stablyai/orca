import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { CHAT_ADDRESS_PREVIEW_LIMIT } from '../../shared/chat-address-preview'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { isTrustedBrowserRenderer } from '../ipc/browser-renderer-trust'
import type { PreviewNetworkBudget } from './chat-address-preview-network'

export const CHAT_ADDRESS_PREVIEW_SCHEME = 'orca-chat-preview'
export type PreviewResource =
  | { type: 'bytes'; bytes: Buffer }
  | { type: 'local'; handle: FileHandle; size: number }
  | { type: 'network'; url: URL; allowPrivateNetwork: boolean; size?: number }

export type ChatPreviewGrant = {
  id: string
  token: string
  owner: WebContents
  controller: AbortController
  resource?: PreviewResource
  mimeType: string
  activeStreams: number
  budget: PreviewNetworkBudget
}
type PreviewOwner = {
  entries: Map<string, ChatPreviewGrant>
  dispose: () => void
}
const owners = new Map<number, PreviewOwner>()
const grants = new Map<string, ChatPreviewGrant>()
const MAX_GLOBAL_PREVIEWS = 64

export function releaseChatPreviewGrant(grant: ChatPreviewGrant): void {
  grant.controller.abort(new Error('Preview released'))
  grants.delete(grant.token)
  if (grant.resource?.type === 'local') {
    void grant.resource.handle.close().catch(() => {})
  }
  grant.resource = undefined
  const owner = owners.get(grant.owner.id)
  if (owner?.entries.get(grant.id) !== grant) {
    return
  }
  owner.entries.delete(grant.id)
  if (!owner.entries.size) {
    owners.delete(grant.owner.id)
    owner.dispose()
  }
}

export function releaseOwnedChatPreview(ownerId: number, id: string): void {
  const grant = owners.get(ownerId)?.entries.get(id)
  if (grant) {
    releaseChatPreviewGrant(grant)
  }
}

export function createChatPreviewGrant(owner: WebContents, id: string): ChatPreviewGrant {
  releaseOwnedChatPreview(owner.id, id)
  if (
    (owners.get(owner.id)?.entries.size ?? 0) >= CHAT_ADDRESS_PREVIEW_LIMIT ||
    grants.size >= MAX_GLOBAL_PREVIEWS
  ) {
    throw new Error('Preview count limit reached')
  }
  let state = owners.get(owner.id)
  if (!state) {
    const lifetime = abortWhenRendererGone(owner)
    state = { entries: new Map(), dispose: lifetime.dispose }
    const entries = state.entries
    lifetime.signal.addEventListener(
      'abort',
      () => {
        for (const grant of entries.values()) {
          releaseChatPreviewGrant(grant)
        }
        lifetime.dispose()
      },
      { once: true }
    )
    owners.set(owner.id, state)
  }
  const grant: ChatPreviewGrant = {
    id,
    token: randomUUID(),
    owner,
    controller: new AbortController(),
    mimeType: 'application/octet-stream',
    activeStreams: 0,
    budget: { requests: 0 }
  }
  state.entries.set(id, grant)
  grants.set(grant.token, grant)
  return grant
}

export function getChatPreviewGrant(rawUrl: string): ChatPreviewGrant | undefined {
  try {
    const url = new URL(rawUrl)
    if (
      url.protocol !== `${CHAT_ADDRESS_PREVIEW_SCHEME}:` ||
      url.hostname !== 'resource' ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    const grant = grants.get(url.pathname.slice(1))
    if (!grant || grant.controller.signal.aborted || !isTrustedBrowserRenderer(grant.owner)) {
      return undefined
    }
    return grant
  } catch {
    return undefined
  }
}

/** Shared with the existing session request gate: protocol Request omits webContentsId. */
export function isAllowedChatPreviewRequest(details: {
  url: string
  webContentsId?: number
  resourceType?: string
}): boolean {
  if (!details.url.startsWith(`${CHAT_ADDRESS_PREVIEW_SCHEME}:`)) {
    return true
  }
  const grant = getChatPreviewGrant(details.url)
  return Boolean(
    grant &&
    details.webContentsId === grant.owner.id &&
    ['image', 'media', 'xhr'].includes(details.resourceType ?? '')
  )
}
