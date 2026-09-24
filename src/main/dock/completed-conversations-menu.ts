import { app, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import {
  DOCK_CONVERSATION_OPEN,
  DOCK_CONVERSATIONS_UPDATE,
  readDockCompletedConversations,
  type DockCompletedConversation
} from '../../shared/dock-completed-conversations'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from '../ipc/ui'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { mainI18n, translateMain } from '../i18n/main-i18n'

const GROUP_SIZE = 20
let disposeMenu: (() => void) | null = null

export function buildCompletedConversationsMenu(
  entries: readonly DockCompletedConversation[],
  open: (id: string) => void
): MenuItemConstructorOptions[] {
  if (entries.length === 0) {
    return [
      {
        label: translateMain('dock.noCompletedConversations', 'No completed conversations to read'),
        enabled: false
      }
    ]
  }
  const items = entries.map((entry) => ({ label: entry.label, click: () => open(entry.id) }))
  const groups: MenuItemConstructorOptions[] = []
  for (let offset = 0; offset < items.length; offset += GROUP_SIZE) {
    groups.push({
      label: `${offset + 1}–${Math.min(offset + GROUP_SIZE, items.length)}`,
      submenu: items.slice(offset, offset + GROUP_SIZE)
    })
  }
  return [
    {
      label: `${translateMain('dock.completedConversations', 'Completed, unread')} (${entries.length})`,
      enabled: false
    },
    ...(items.length <= GROUP_SIZE ? items : groups)
  ]
}

export function registerCompletedConversationsMenu(): void {
  disposeMenu?.()
  disposeMenu = null
  if (process.platform !== 'darwin') {
    return
  }
  let entries: DockCompletedConversation[] = []
  let owner: WebContents | null = null
  const open = (id: string): void => {
    if (!entries.some((entry) => entry.id === id) || owner !== getTrustedUIRendererWebContents()) {
      return
    }
    const window = getTrustedUIRendererWindow()
    if (!window || window.isDestroyed()) {
      return
    }
    safelyRevealWindow(window)
    window.webContents.send(DOCK_CONVERSATION_OPEN, id)
  }
  const render = (): void => {
    app.dock?.setMenu(Menu.buildFromTemplate(buildCompletedConversationsMenu(entries, open)))
  }
  const release = (): void => {
    owner?.removeListener('did-start-navigation', onNavigation)
    owner?.removeListener('render-process-gone', release)
    owner?.removeListener('destroyed', release)
    owner = null
    entries = []
    render()
  }
  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      release()
    }
  }
  ipcMain.removeHandler(DOCK_CONVERSATIONS_UPDATE)
  ipcMain.handle(DOCK_CONVERSATIONS_UPDATE, (event, payload: unknown) => {
    if (event.sender !== getTrustedUIRendererWebContents()) {
      return
    }
    const next = readDockCompletedConversations(payload)
    if (owner !== event.sender) {
      release()
      owner = event.sender
      owner.on('did-start-navigation', onNavigation)
      owner.once('render-process-gone', release)
      owner.once('destroyed', release)
    }
    if (JSON.stringify(entries) === JSON.stringify(next)) {
      return
    }
    entries = next
    render()
  })
  mainI18n.on('languageChanged', render)
  const dispose = (): void => {
    mainI18n.off('languageChanged', render)
    app.removeListener('will-quit', dispose)
    release()
    ipcMain.removeHandler(DOCK_CONVERSATIONS_UPDATE)
  }
  disposeMenu = dispose
  app.once('will-quit', dispose)
  render()
}
