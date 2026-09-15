import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { getAppIconPath } from '../app-icon'
import {
  isValidWindowPlacement,
  readMonitorDisplays,
  recoverWindowPlacement
} from './monitor-placement'
import { installMonitorTopologyRecovery } from './monitor-topology'
import { isWindowlessLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { MIN_HEIGHT, MIN_WIDTH } from './main-window-visual-lifecycle'
import { authorizeWorkspaceWindowNativeBridge } from './workspace-window-native-bridge'
import { installWorkspaceWindowCloseLifecycle } from './workspace-window-close-lifecycle'

const PLACEMENT_SAVE_DELAY_MS = 150
const closedWindows = new WeakMap<Store, string[]>()

export function getClosedWorkspaceWindowId(store: Store): string | undefined {
  return closedWindows.get(store)?.at(-1)
}

type WorkspaceWindowOptions = {
  getIsQuitting: () => boolean
  runtimeRpc: OrcaRuntimeRpcServer
  store: Store
  title: string
  windowId?: string
}

function persistWorkspaceWindow(
  store: Store,
  windowId: string,
  placement?: { bounds: Electron.Rectangle; maximized: boolean }
): void {
  const ui = store.getUI()
  const workspaceWindowIds = ui.workspaceWindowIds?.includes(windowId)
    ? ui.workspaceWindowIds
    : [...(ui.workspaceWindowIds ?? []), windowId]
  store.updateUI({
    workspaceWindowIds,
    ...(placement
      ? {
          workspaceWindowPlacements: {
            ...ui.workspaceWindowPlacements,
            [windowId]: placement
          }
        }
      : {})
  })
}

export function createWorkspaceWindow(options: WorkspaceWindowOptions): BrowserWindow {
  const windowId = options.windowId ?? randomUUID()
  const offer = options.runtimeRpc.createPairingOffer({
    address: '127.0.0.1',
    name: `Orca Window ${windowId}`,
    reach: 'this-computer',
    reuseDeviceName: true,
    scope: 'runtime'
  })
  if (!offer.available || !offer.webClientUrl) {
    throw new Error('workspace_window_runtime_unavailable')
  }

  const saved = options.store.getUI().workspaceWindowPlacements?.[windowId]
  const savedBounds =
    saved?.bounds &&
    isValidWindowPlacement(saved.bounds) &&
    saved.bounds.width > MIN_WIDTH &&
    saved.bounds.height > MIN_HEIGHT
      ? recoverWindowPlacement(
          saved.bounds,
          readMonitorDisplays(() => screen.getAllDisplays())
        )
      : undefined
  const fallback = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: savedBounds?.width ?? Math.max(MIN_WIDTH + 1, Math.min(fallback.width, 1200)),
    height: savedBounds?.height ?? Math.max(MIN_HEIGHT + 1, Math.min(fallback.height, 800)),
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: options.title,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    icon: getAppIconPath(options.store.getSettings().appIcon),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:orca-workspace-window-${windowId}`,
      preload: join(__dirname, 'workspace-window-preload.js'),
      sandbox: true,
      additionalArguments: [`--orca-local-runtime-id=${options.runtimeRpc.getRuntimeId()}`]
    }
  })
  window.on('page-title-updated', (event) => event.preventDefault())
  authorizeWorkspaceWindowNativeBridge(window, offer.webClientUrl, windowId)
  closedWindows.set(
    options.store,
    (closedWindows.get(options.store) ?? []).filter((id) => id !== windowId)
  )
  persistWorkspaceWindow(options.store, windowId)
  installWorkspaceWindowCloseLifecycle(window, options.getIsQuitting)

  let placementTimer: ReturnType<typeof setTimeout> | null = null
  const savePlacement = (): void => {
    if (placementTimer) {
      clearTimeout(placementTimer)
    }
    placementTimer = null
    if (window.isDestroyed()) {
      return
    }
    persistWorkspaceWindow(options.store, windowId, {
      bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(),
      maximized: window.isMaximized()
    })
  }
  const persistPlacement = (): void => {
    if (placementTimer) {
      clearTimeout(placementTimer)
    }
    placementTimer = setTimeout(savePlacement, PLACEMENT_SAVE_DELAY_MS)
    placementTimer.unref?.()
  }
  window.on('move', persistPlacement)
  window.on('resize', persistPlacement)
  window.on('maximize', persistPlacement)
  window.on('unmaximize', persistPlacement)
  window.on('close', savePlacement)
  installMonitorTopologyRecovery({
    displays: () => screen.getAllDisplays(),
    screen,
    window,
    onRecovered: (bounds, maximized) => {
      persistWorkspaceWindow(options.store, windowId, { bounds, maximized })
    }
  })
  window.once('ready-to-show', () => {
    if (saved?.maximized === true && !isWindowlessLaunch() && !window.isDestroyed()) {
      window.maximize()
    }
    showWindowWithoutStealingFocus(window)
  })
  window.on('closed', () => {
    if (placementTimer) {
      clearTimeout(placementTimer)
    }
    if (!options.getIsQuitting()) {
      closedWindows.set(options.store, [
        ...(closedWindows.get(options.store) ?? []).slice(-19),
        windowId
      ])
      options.runtimeRpc.revokeRuntimeAccess(offer.deviceId)
      const ui = options.store.getUI()
      options.store.updateUI({
        workspaceWindowIds: (ui.workspaceWindowIds ?? []).filter((id) => id !== windowId)
      })
    }
  })

  const url = new URL(offer.webClientUrl)
  url.searchParams.set('workspaceWindowId', windowId)
  void window.loadURL(url.toString()).catch((error: unknown) => {
    console.error('[window] Workspace window load failed', error)
  })
  return window
}
