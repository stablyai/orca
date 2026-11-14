import { BrowserWindow, nativeTheme, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import { installPrivilegedWindowNavigationPolicy } from '../security/privileged-window-navigation'
import { wslHostsWindowArguments } from '../../wsl/host-lifecycle/wsl-host-gate'
import { resolveRestoredBounds } from '../presentation/window-bounds-validation'
import {
  WORKSPACE_POPOUT_DEFAULT_HEIGHT,
  WORKSPACE_POPOUT_DEFAULT_WIDTH,
  WORKSPACE_POPOUT_MIN_HEIGHT,
  WORKSPACE_POPOUT_MIN_WIDTH,
  WORKSPACE_POPOUT_PARTITION,
  type WorkspacePopoutTarget
} from '../../../shared/workspace-popout/workspace-popout-contract'

export function createPopoutBrowserWindow(
  store: Store | null,
  target: WorkspacePopoutTarget
): BrowserWindow {
  const savedBounds = resolveRestoredBounds(store?.getUI().workspacePopoutBounds, {
    minWidth: WORKSPACE_POPOUT_MIN_WIDTH,
    minHeight: WORKSPACE_POPOUT_MIN_HEIGHT,
    logTag: '[workspace-popout]'
  })

  const wslArguments = wslHostsWindowArguments()
  const options: BrowserWindowConstructorOptions = {
    width: savedBounds?.width ?? WORKSPACE_POPOUT_DEFAULT_WIDTH,
    height: savedBounds?.height ?? WORKSPACE_POPOUT_DEFAULT_HEIGHT,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: WORKSPACE_POPOUT_MIN_WIDTH,
    minHeight: WORKSPACE_POPOUT_MIN_HEIGHT,
    title: target.title || 'Orca Terminal',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      partition: WORKSPACE_POPOUT_PARTITION,
      webviewTag: false,
      ...(wslArguments.length > 0 ? { additionalArguments: wslArguments } : {})
    }
  }

  const window = new BrowserWindow(options)
  installPrivilegedWindowNavigationPolicy(window.webContents)
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  window.webContents.session.setPermissionCheckHandler(() => false)

  return window
}
