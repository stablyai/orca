import { clipboard, ipcMain, type BrowserWindow } from 'electron'
import {
  richMarkdownContextMenuLinkTargetChannel,
  type RichMarkdownContextMenuLinkTarget
} from '../../shared/rich-markdown-context-menu'
import { readInstalledBrowserSnapshot } from '../external-browsers/installed-browser-catalog'
import {
  openExternalUrl,
  readConfiguredExternalBrowserId
} from '../external-browsers/open-external-url'
import {
  parseRichMarkdownContextMenuLinkTarget,
  type EditableContextMenuLinkActions
} from './editable-context-menu-link-section'
import { parseHttpUrl, resolveInstalledBrowserName } from '../../shared/external-browser-types'

export type RichMarkdownLinkContextMenu = {
  /** Opens synchronously; the link section lists the last completed browser scan. */
  withLinkActions: (
    params: Pick<Electron.ContextMenuParams, 'x' | 'y' | 'isEditable' | 'linkURL'>,
    open: (link?: EditableContextMenuLinkActions) => void
  ) => void
  reset: () => void
  dispose: () => void
}

/** Supplies the rich editor's native link section from main's browser catalog. */
export function installRichMarkdownLinkContextMenu(
  mainWindow: BrowserWindow
): RichMarkdownLinkContextMenu {
  // Renderer sends this immediately before the native menu when Orca Browser can open the link.
  let pendingTarget: RichMarkdownContextMenuLinkTarget | null = null
  const onLinkTarget = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender === mainWindow.webContents) {
      pendingTarget = parseRichMarkdownContextMenuLinkTarget(value)
    }
  }
  ipcMain.on(richMarkdownContextMenuLinkTargetChannel, onLinkTarget)

  const withLinkActions: RichMarkdownLinkContextMenu['withLinkActions'] = (params, open) => {
    const canOpenInOrca = pendingTarget?.x === params.x && pendingTarget?.y === params.y
    pendingTarget = null
    if (!params.isEditable || !parseHttpUrl(params.linkURL)) {
      open()
      return
    }
    // Never wait on a rescan: a late scan would pop a stale menu over newer input.
    const browsers = readInstalledBrowserSnapshot()
    open({
      canOpenInOrca,
      browsers,
      externalDefaultName: resolveInstalledBrowserName(readConfiguredExternalBrowserId(), browsers),
      openUrl: (url, browserId) => void openExternalUrl(url, { browserId }),
      copyText: (text) => clipboard.writeText(text)
    })
  }

  return {
    withLinkActions,
    reset: () => {
      pendingTarget = null
    },
    dispose: () => {
      pendingTarget = null
      ipcMain.removeListener(richMarkdownContextMenuLinkTargetChannel, onLinkTarget)
    }
  }
}
