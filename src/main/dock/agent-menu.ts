import { app, ipcMain, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'
import {
  DOCK_AGENT_MENU_UPDATE,
  DOCK_AGENT_OPEN,
  readDockAgentMenuPayload,
  type DockAgentEntry,
  type DockAgentMenuPayload
} from '../../shared/dock-agent-menu'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from '../ipc/ui'
import { translateMain, mainI18n } from '../i18n/main-i18n'
import { safelyRevealWindow } from '../window/focus-existing-window'

let disposeMenu: (() => void) | null = null

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
    ...(entries.length > 0
      ? entries.map((entry) => ({
          label: entry.label,
          click: () => open(entry)
        }))
      : [{ label: emptyLabel, enabled: false }])
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
    if (
      owner !== getTrustedUIRendererWebContents() ||
      (!payload.active.some((candidate) => candidate.id === entry.id) &&
        !payload.unread.some((candidate) => candidate.id === entry.id))
    ) {
      return
    }
    const window = getTrustedUIRendererWindow()
    if (!window || window.isDestroyed()) {
      return
    }
    safelyRevealWindow(window)
    window.webContents.send(DOCK_AGENT_OPEN, entry.target)
  }

  const render = (): void => {
    app.dock?.setMenu(Menu.buildFromTemplate(buildDockAgentMenu(payload, open)))
  }

  const release = (): void => {
    owner?.removeListener('did-start-navigation', onNavigation)
    owner?.removeListener('render-process-gone', release)
    owner?.removeListener('destroyed', release)
    owner = null
    payload = { active: [], unread: [] }
    render()
  }

  const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      release()
    }
  }

  ipcMain.removeHandler(DOCK_AGENT_MENU_UPDATE)
  ipcMain.handle(DOCK_AGENT_MENU_UPDATE, (event, value: unknown): void => {
    if (event.sender !== getTrustedUIRendererWebContents()) {
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
      owner.on('did-start-navigation', onNavigation)
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
