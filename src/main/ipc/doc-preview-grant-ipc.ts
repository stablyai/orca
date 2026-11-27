import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import {
  buildDocPreviewUrl,
  DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL,
  DOC_PREVIEW_LINK_CLICK_CHANNEL,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL
} from '../../shared/document-preview/doc-preview-scheme'
import { browserManager } from '../browser/guest-lifecycle/manager/browser-manager'
import { reportDocPreviewLinkClick } from '../browser/document-preview/doc-preview-guest-policy'
import {
  authorizeDocPreviewDirectory,
  mintDocPreviewGrant,
  revokeDocPreviewGrant,
  type DocPreviewOwner
} from '../browser/document-preview/doc-preview-grant-registry'
import { isTrustedBrowserRenderer } from './browser/browser-renderer-trust'

export type DocPreviewGrantRequest = {
  owner: DocPreviewOwner
  /** Directory relative preview URLs resolve against. */
  requestBase: string
  /** Containing directory of the opened document, on the owning host. */
  root: string
  /** Opened document, relative to `requestBase`. */
  entryRelativePath: string
  /** Browser page the reader is opening the document in; main registers the guest under it. */
  browserPageId: string
}

export type DocPreviewGrantResult = { grantId: string; url: string }

function isValidGrantRequest(request: DocPreviewGrantRequest): boolean {
  if (!request.requestBase.trim() || !request.root.trim() || !request.entryRelativePath.trim()) {
    return false
  }
  if (typeof request.browserPageId !== 'string' || !request.browserPageId.trim()) {
    return false
  }
  return Boolean(
    request.owner.kind === 'runtime' &&
    request.owner.environmentId.trim() &&
    request.owner.worktreeSelector.trim() &&
    request.owner.worktreeRoot.trim()
  )
}

/** Grants read through the owning server's worktree-scoped files.read or its file grants. */
export function registerDocPreviewGrantHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    DOC_PREVIEW_MINT_GRANT_CHANNEL,
    (event, request: DocPreviewGrantRequest): DocPreviewGrantResult => {
      // Granting filesystem-read authority requires a trusted renderer even if guests cannot currently invoke IPC.
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('Untrusted document preview grant request')
      }
      if (!isValidGrantRequest(request)) {
        throw new Error('Invalid document preview grant request')
      }
      // A page ID cannot belong to both browser and document registries.
      if (browserManager.getGuestWebContentsId(request.browserPageId) !== null) {
        throw new Error('Document preview grant names a browsing page')
      }
      const grant = mintDocPreviewGrant({
        owner: request.owner,
        requestBase: request.requestBase,
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

  ipc.handle(DOC_PREVIEW_REVOKE_GRANT_CHANNEL, (event, grantId: string): boolean =>
    isTrustedBrowserRenderer(event.sender) ? revokeDocPreviewGrant(grantId) : false
  )

  ipc.handle(
    DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL,
    (event, grantId: unknown, relativePath: unknown): boolean =>
      isTrustedBrowserRenderer(event.sender) &&
      typeof grantId === 'string' &&
      typeof relativePath === 'string' &&
      authorizeDocPreviewDirectory(grantId, relativePath)
  )

  if (ipc === ipcMain) {
    // Guest senders are untrusted; the policy checks a live bound grant and web URL.
    ipcMain.on(DOC_PREVIEW_LINK_CLICK_CHANNEL, (event, url: unknown, modifiers?: unknown) => {
      if (typeof url === 'string') {
        reportDocPreviewLinkClick(event.sender, url, modifiers)
      }
    })
  }
}
