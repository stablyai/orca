import { app, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import {
  DOCK_AGENT_MENU_UPDATE,
  DOCK_AGENT_OPEN,
  DOCK_AGENT_MENU_PAGE_SIZE,
  readDockAgentMenuPayload,
  type DockAgentEntry,
  type DockAgentMenuPayload
} from '../../shared/dock-agent-menu'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from '../ipc/ui'
import { translateMain, mainI18n } from '../i18n/main-i18n'
import { safelyRevealWindow } from '../window/focus-existing-window'

let disposeMenu: (() => void) | null = null

function agentItems(
  entries: readonly DockAgentEntry[],
  open: (entry: DockAgentEntry) => void,
  offset = 0
): MenuItemConstructorOptions[] {
  if (entries.length <= DOCK_AGENT_MENU_PAGE_SIZE) {
    return entries.map((entry) => ({ label: entry.label, click: () => open(entry) }))
  }
  // Keep both the fan-out and leaf menus small, even with thousands of conversations.
  let rangeSize = DOCK_AGENT_MENU_PAGE_SIZE
  while (Math.ceil(entries.length / rangeSize) > DOCK_AGENT_MENU_PAGE_SIZE) {
    rangeSize *= DOCK_AGENT_MENU_PAGE_SIZE
  }
  const items: MenuItemConstructorOptions[] = []
  for (let start = 0; start < entries.length; start += rangeSize) {
    const end = Math.min(start + rangeSize, entries.length)
    items.push({
      label: `${offset + start + 1}–${offset + end}`,
      submenu: agentItems(entries.slice(start, end), open, offset + start)
    })
  }
  return items
}

function sectionItems(
  title: string,
  emptyLabel: string,
  entries: readonly DockAgentEntry[],
  open: (entry: DockAgentEntry) => void
): MenuItemConstructorOptions[] {
  return [
    {
      label: `${title} (${entries.length})`,
      enabled: false
    },
    ...(entries.length > 0 ? agentItems(entries, open) : [{ label: emptyLabel, enabled: false }])
  ]
}

/** Builds the native menu while keeping every admitted entry reachable. */
export function buildDockAgentMenu(
  payload: DockAgentMenuPayload,
  open: (entry: DockAgentEntry) => void
): MenuItemConstructorOptions[] {
  return [
    ...sectionItems(
      translateMain('dock.activeAgents', 'Active agents'),
      translateMain('dock.noActiveAgents', 'No active agents'),
      payload.active,
      open
    ),
    { type: 'separator' },
    ...sectionItems(
      translateMain('dock.unreadMessages', 'Unread messages'),
      translateMain('dock.noUnreadMessages', 'No unread messages'),
      payload.unread,
      open
    )
  ]
}

function samePayload(left: DockAgentMenuPayload, right: DockAgentMenuPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Registers the macOS Dock context menu and its trusted renderer bridge. */
export function registerDockAgentMenu(): void {
  disposeMenu?.()
  disposeMenu = null
  if (process.platform !== 'darwin') {
    return
  }

  let payload: DockAgentMenuPayload = { active: [], unread: [] }
  let owner: WebContents | null = null

  const open = (entry: DockAgentEntry): void => {
    if (owner !== getTrustedUIRendererWebContents()) {
      return
    }
    const current =
      payload.active.find((candidate) => candidate.id === entry.id) ??
      payload.unread.find((candidate) => candidate.id === entry.id)
    if (!current) {
      return
    }
    const window = getTrustedUIRendererWindow()
    if (!window || window.isDestroyed()) {
      return
    }
    safelyRevealWindow(window)
    window.webContents.send(DOCK_AGENT_OPEN, current.target)
  }

  const render = (): void => {
    app.dock?.setMenu(Menu.buildFromTemplate(buildDockAgentMenu(payload, open)))
  }

  const release = (): void => {
    owner?.removeListener('did-navigate', release)
    owner?.removeListener('render-process-gone', release)
    owner?.removeListener('destroyed', release)
    owner = null
    payload = { active: [], unread: [] }
    render()
  }

  ipcMain.removeHandler(DOCK_AGENT_MENU_UPDATE)
  ipcMain.handle(DOCK_AGENT_MENU_UPDATE, (event, value: unknown): void => {
    if (
      event.sender !== getTrustedUIRendererWebContents() ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      return
    }
    let next: DockAgentMenuPayload
    try {
      next = readDockAgentMenuPayload(value)
    } catch (error) {
      console.warn(
        '[dock] rejected malformed agent menu:',
        error instanceof Error ? error.message : String(error)
      )
      return
    }
    if (owner !== event.sender) {
      release()
      owner = event.sender
      // Started navigations can be blocked without replacing the renderer document.
      owner.once('did-navigate', release)
      owner.once('render-process-gone', release)
      owner.once('destroyed', release)
    }
    if (samePayload(payload, next)) {
      return
    }
    payload = next
    render()
  })

  mainI18n.on('languageChanged', render)
  const dispose = (): void => {
    mainI18n.off('languageChanged', render)
    app.removeListener('will-quit', dispose)
    release()
    ipcMain.removeHandler(DOCK_AGENT_MENU_UPDATE)
    if (disposeMenu === dispose) {
      disposeMenu = null
    }
  }
  disposeMenu = dispose
  app.once('will-quit', dispose)
  render()
}
