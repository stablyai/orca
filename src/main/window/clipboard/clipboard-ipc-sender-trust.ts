import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { isTrustedMainRendererSender } from '../../ipc/renderer-requests/main-renderer-sender-trust'
import { isDashboardPopoutRenderer } from '../dashboard-popout-window'
import { getTerminalPopoutPtyId } from '../terminal-popout-window'

let trustedClipboardRendererWebContentsId: number | null = null

export function setTrustedClipboardRendererWebContentsId(webContentsId: number | null): void {
  trustedClipboardRendererWebContentsId = webContentsId
}

export function assertTrustedClipboardSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedClipboardRenderer(event.sender)) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

export function assertTrustedClipboardTextSender(event: IpcMainInvokeEvent): void {
  // Popouts need text clipboard authority only; never extend it to images, files or remote operations.
  if (
    !isTrustedClipboardRenderer(event.sender) &&
    !isDashboardPopoutRenderer(event.sender) &&
    getTerminalPopoutPtyId(event.sender) === null
  ) {
    throw new Error('Unauthorized clipboard IPC sender')
  }
}

function isTrustedClipboardRenderer(sender: WebContents): boolean {
  return isTrustedMainRendererSender(sender, trustedClipboardRendererWebContentsId)
}
