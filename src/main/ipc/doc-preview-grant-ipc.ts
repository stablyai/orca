import { ipcMain } from 'electron'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_LINK_CLICK_CHANNEL,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL
} from '../../shared/doc-preview-scheme'
import { browserManager } from '../browser/browser-manager'
import { reportDocPreviewLinkClick } from '../browser/doc-preview-guest-policy'
import {
  mintDocPreviewGrant,
  revokeDocPreviewGrant,
  type DocPreviewOwner
} from '../browser/doc-preview-grant-registry'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export type DocPreviewGrantRequest = {
  owner: DocPreviewOwner
  /** Containing directory of the opened document, on the owning host. */
  root: string
  /** Opened document, relative to `root`. */
  entryRelativePath: string
  /** Browser page the reader is opening the document in; main registers the guest under it. */
  browserPageId: string
}

export type DocPreviewGrantResult = { grantId: string; url: string }

function isValidGrantRequest(request: DocPreviewGrantRequest): boolean {
  if (!request.root.trim() || !request.entryRelativePath.trim()) {
    return false
  }
  if (typeof request.browserPageId !== 'string' || !request.browserPageId.trim()) {
    return false
  }
  if (request.owner.kind === 'ssh') {
    return Boolean(request.owner.connectionId.trim())
  }
  return Boolean(
    request.owner.environmentId.trim() &&
    request.owner.worktreeSelector.trim() &&
    request.owner.worktreeRoot.trim()
  )
}

/**
 * Minting never widens what the renderer can already read: an SSH grant reads
 * through the same provider as `fs:readFile`, and a runtime grant through the
 * same worktree-scoped `files.read` RPC the renderer can call directly.
 */
export function registerDocPreviewGrantHandlers(): void {
  ipcMain.handle(
    DOC_PREVIEW_MINT_GRANT_CHANNEL,
    (event, request: DocPreviewGrantRequest): DocPreviewGrantResult => {
      // Why gate a channel guests cannot reach today: this one hands out filesystem-read
      // authority, so it holds the same sender check its sibling browser channels do rather than
      // relying on guests never gaining an ipcRenderer.
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('Untrusted document preview grant request')
      }
      if (!isValidGrantRequest(request)) {
        throw new Error('Invalid document preview grant request')
      }
      // Why the other half of the registry is consulted here: this is where a page first becomes a
      // document page, and the two halves must stay disjoint. Naming a page that already hosts a
      // browsing guest would make one id resolve in both.
      if (browserManager.getGuestWebContentsId(request.browserPageId) !== null) {
        throw new Error('Document preview grant names a browsing page')
      }
      const grant = mintDocPreviewGrant({
        owner: request.owner,
        root: request.root,
        entryRelativePath: request.entryRelativePath,
        browserPageId: request.browserPageId
      })
      return {
        grantId: grant.id,
        url: buildDocPreviewUrl(grant.id, grant.entryRelativePath)
      }
    }
  )

  ipcMain.handle(DOC_PREVIEW_REVOKE_GRANT_CHANNEL, (event, grantId: string): boolean =>
    isTrustedBrowserRenderer(event.sender) ? revokeDocPreviewGrant(grantId) : false
  )

  // Why no trusted-renderer check here: the sender is a preview guest rendering a workspace
  // document, which is exactly the untrusted side. `reportDocPreviewLinkClick` is the gate — a
  // live bound grant, a focused guest, a web URL — and it drops everything else silently.
  ipcMain.on(DOC_PREVIEW_LINK_CLICK_CHANNEL, (event, url: unknown) => {
    if (typeof url === 'string') {
      reportDocPreviewLinkClick(event.sender, url)
    }
  })
}
