import type { BrowserWindow } from 'electron'
import type { DetachedTerminalSnapshot } from '../../shared/detached-terminal-window'
import { trustedRendererRegistry } from './trusted-renderer-registry'
import { paneOwnershipRegistry } from './pane-ownership-registry'

export type AppWindowKind = 'main' | 'detached-terminal'
export type DetachedWindowKey = { worktreeId: string; tabId: string }

type AppWindowRecord = {
  kind: AppWindowKind
  window: BrowserWindow
  webContentsId: number
  key?: DetachedWindowKey
  snapshot?: DetachedTerminalSnapshot
}

class DetachedWindowRegistry {
  private readonly recordsByWindow = new Map<BrowserWindow, AppWindowRecord>()
  private readonly detachedByKey = new Map<string, AppWindowRecord>()
  private primaryMainWindow: BrowserWindow | null = null

  registerMainWindow(window: BrowserWindow): void {
    this.unregisterWindow(window)
    const webContentsId = window.webContents.id
    this.recordsByWindow.set(window, { kind: 'main', window, webContentsId })
    this.primaryMainWindow = window
    paneOwnershipRegistry.setPrimaryAppWebContentsId(webContentsId)
    this.unregisterOnClose(window)
  }

  registerDetachedTerminalWindow(
    key: DetachedWindowKey,
    window: BrowserWindow,
    snapshot: DetachedTerminalSnapshot
  ): void {
    this.unregisterWindow(window)
    const record: AppWindowRecord = {
      kind: 'detached-terminal',
      window,
      webContentsId: window.webContents.id,
      key,
      snapshot
    }
    this.recordsByWindow.set(window, record)
    this.detachedByKey.set(this.keyString(key), record)
    this.unregisterOnClose(window)
  }

  unregisterWindow(window: BrowserWindow): void {
    const record = this.recordsByWindow.get(window)
    if (!record) {
      return
    }
    this.recordsByWindow.delete(window)
    if (record.kind === 'main' && this.primaryMainWindow === window) {
      this.primaryMainWindow = this.findFirstMainWindow()
      paneOwnershipRegistry.setPrimaryAppWebContentsId(
        this.getPrimaryAppWindow()?.webContents.id ?? null
      )
    }
    if (record.kind === 'detached-terminal' && record.key) {
      this.detachedByKey.delete(this.keyString(record.key))
    }
    const { webContentsId } = record
    if (typeof webContentsId === 'number') {
      trustedRendererRegistry.clearWebContents(webContentsId)
      paneOwnershipRegistry.clearPaneOwnerByWebContentsId(webContentsId)
    }
  }

  getDetachedTerminalWindow(key: DetachedWindowKey): BrowserWindow | null {
    const record = this.getLiveDetachedRecord(key)
    return record?.window ?? null
  }

  getDetachedTerminalSnapshot(key: DetachedWindowKey): DetachedTerminalSnapshot | null {
    const record = this.getLiveDetachedRecord(key)
    return record?.snapshot ?? null
  }

  focusDetachedTerminalWindow(key: DetachedWindowKey): boolean {
    const window = this.getDetachedTerminalWindow(key)
    if (!window) {
      return false
    }
    window.focus()
    return true
  }

  closeDetachedTerminalWindow(key: DetachedWindowKey): void {
    const window = this.getDetachedTerminalWindow(key)
    if (!window) {
      return
    }
    this.unregisterWindow(window)
    if (!window.isDestroyed()) {
      window.close()
    }
  }

  getAppWindows(): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    for (const [window] of this.recordsByWindow) {
      if (!window.isDestroyed()) {
        windows.push(window)
      }
    }
    return windows
  }

  getPrimaryAppWindow(): BrowserWindow | null {
    if (this.primaryMainWindow && !this.primaryMainWindow.isDestroyed()) {
      return this.primaryMainWindow
    }
    this.primaryMainWindow = this.findFirstMainWindow()
    return this.primaryMainWindow
  }

  private getLiveDetachedRecord(key: DetachedWindowKey): AppWindowRecord | null {
    const record = this.detachedByKey.get(this.keyString(key))
    if (!record || record.window.isDestroyed()) {
      if (record) {
        this.unregisterWindow(record.window)
      }
      return null
    }
    return record
  }

  private findFirstMainWindow(): BrowserWindow | null {
    for (const record of this.recordsByWindow.values()) {
      if (record.kind === 'main' && !record.window.isDestroyed()) {
        return record.window
      }
    }
    return null
  }

  private unregisterOnClose(window: BrowserWindow): void {
    window.on('closed', () => {
      this.unregisterWindow(window)
    })
  }

  private keyString(key: DetachedWindowKey): string {
    return `${key.worktreeId}\u0000${key.tabId}`
  }
}

export const detachedWindowRegistry = new DetachedWindowRegistry()
