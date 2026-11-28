import { ipcMain } from 'electron'
import {
  DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL,
  DOC_PREVIEW_LINK_CLICK_CHANNEL,
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL
} from '../../shared/document-preview/doc-preview-scheme'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const DOC_PREVIEW_HANDLE_CHANNELS = [
  DOC_PREVIEW_MINT_GRANT_CHANNEL,
  DOC_PREVIEW_REVOKE_GRANT_CHANNEL,
  DOC_PREVIEW_AUTHORIZE_DIRECTORY_CHANNEL
] as const

export function registerLazyDocPreviewGrantHandlers(): void {
  registerLazyIpcHandleGroup(DOC_PREVIEW_HANDLE_CHANNELS, async (ipc) => {
    const { registerDocPreviewGrantHandlers } = await import('./doc-preview-grant-ipc')
    registerDocPreviewGrantHandlers(ipc)
  })
  // Guest senders are untrusted; the policy checks a live bound grant and web URL.
  ipcMain.on(DOC_PREVIEW_LINK_CLICK_CHANNEL, (event, url: unknown, modifiers?: unknown) => {
    if (typeof url !== 'string') {
      return
    }
    const sender = event.sender
    void import('../browser/document-preview/doc-preview-guest-policy')
      .then(({ reportDocPreviewLinkClick }) => {
        if (!sender.isDestroyed()) {
          reportDocPreviewLinkClick(sender, url, modifiers)
        }
      })
      .catch(() => {})
  })
}
