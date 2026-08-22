import type { BrowserWindow, WebContents } from 'electron'
import type { Store } from '../persistence'
import type { WindowSessionRegistry } from '../persistence/window-session-registry'
import type { OrcaWindowManager } from '../window/orca-window-manager'
import type { PtyRendererOwners } from './pty-renderer-owners'

export type TerminalWindowTransferCoordinatorOptions = {
  store: Store
  createSecondaryWindow: (bounds: Electron.Rectangle) => BrowserWindow
  getIsQuitting?: () => boolean
  windows?: OrcaWindowManager
  sessions?: WindowSessionRegistry
  owners?: PtyRendererOwners
  getCursorPoint?: () => Electron.Point
  getWorkArea?: (point: Electron.Point) => Electron.Rectangle
  loadWindow?: (window: BrowserWindow) => void
  registerRenderer?: (webContents: WebContents) => () => void
  handoff?: (ptyIds: readonly string[], from: WebContents, to: WebContents) => void
  timeoutMs?: number
}
