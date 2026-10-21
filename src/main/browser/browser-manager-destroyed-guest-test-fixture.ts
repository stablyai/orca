import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { BrowserManager } from './browser-manager'

const session = { getUserAgent: () => 'Chrome/140.0.0.0' }

export class DestroyedGuestTestManager extends BrowserManager {
  downloadCount(): number {
    return this.downloadsById.size
  }

  retainedCounts(): Record<string, number> {
    return {
      guests: this.webContentsIdByTabId.size,
      contextMenus: this.contextMenuCleanupByTabId.size,
      grabShortcuts: this.grabShortcutCleanupByTabId.size,
      appShortcuts: this.shortcutForwardingCleanupByTabId.size,
      wheelHandlers: this.mouseWheelZoomCleanupByTabId.size,
      renderers: this.rendererWebContentsIdByTabId.size,
      workspaces: this.workspaceIdByPageId.size,
      worktrees: this.worktreeIdByTabId.size,
      profiles: this.sessionProfileIdByPageId.size,
      policies: this.policyCleanupByGuestId.size
    }
  }
}

export class DestroyedGuestTestContents extends EventEmitter {
  readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => false,
    sendCommand: async () => undefined
  })
  readonly session = session
  private destroyed = false

  constructor(readonly id: number) {
    super()
  }

  asWebContents(): WebContents {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture provides the WebContents methods exercised by guest registration and teardown.
    return this as unknown as WebContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getType(): string {
    return 'webview'
  }

  getURL(): string {
    return 'https://example.test'
  }

  getUserAgent(): string {
    return session.getUserAgent()
  }

  setUserAgent(): void {}
  setWindowOpenHandler(): void {}
  setBackgroundThrottling(): void {}

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}
