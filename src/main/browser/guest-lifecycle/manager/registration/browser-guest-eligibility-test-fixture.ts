import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'
import { BrowserManager } from '../browser-manager'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  reserveBrowserPageDiscard,
  waitForBrowserPageReady
} from '../../browser-page-memory'
import { reportBrowserSessionWebRequest } from '../../../sessions/requests/browser-session-web-request-observer'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import {
  browserGuestActivity,
  registerBrowserGuestActivity,
  unregisterBrowserGuestActivity,
  updateBrowserGuestProtection
} from '../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-activity'
import { installBrowserGuestPageRetention } from '../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-page-retention'
import type { BrowserGuestDiscardProtectionChange } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

export class EligibilityGuest extends DestroyedGuestTestContents {
  readonly hostWebContents = { id: 99 }
  readonly mainFrame = { frames: [], send: vi.fn<(channel: string, generation: string) => void>() }
  loading = true
  devtools = false
  debugged = false
  override readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => this.debugged,
    attach: vi.fn(() => {
      this.debugged = true
    }),
    sendCommand: vi.fn(async () => undefined)
  })
  private finish = (): void => {}
  private readonly load = new Promise<void>((resolve) => {
    this.finish = resolve
  })
  readonly loadURL = () => this.load
  readonly navigationHistory = {
    length: () => 1,
    getActiveIndex: () => 0,
    getAllEntries: () => [{ url: this.getURL(), title: 'Clean' }],
    restore: () => this.load
  }
  readonly executeJavaScript = vi.fn(() => new Promise<unknown>(() => {}))

  isCrashed(): boolean {
    return false
  }
  isLoading(): boolean {
    return this.loading
  }
  isDevToolsOpened(): boolean {
    return this.devtools
  }
  setWebRTCIPHandlingPolicy(): void {}
  close(): void {
    this.destroy()
  }

  clean(): void {
    const url = this.getURL()
    this.emit('did-start-navigation', {
      url,
      frame: this.mainFrame,
      isMainFrame: true,
      isSameDocument: false
    })
    reportBrowserSessionWebRequest(this.asWebContents().session, 'onBeforeRequest', {
      id: this.id,
      url,
      method: 'GET',
      frame: this.asWebContents().mainFrame,
      resourceType: 'mainFrame',
      webContentsId: this.id,
      timestamp: 0
    })
    this.emit('did-navigate', {}, url, 200, 'OK')
    this.emit('dom-ready')
    this.emit(
      'ipc-message',
      { sender: this, senderFrame: this.mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation: this.mainFrame.send.mock.lastCall?.[1], dirty: false }
    )
  }

  stopLoading(): void {
    this.loading = false
    this.emit('did-stop-loading')
  }

  async finishRestore(pageId: string): Promise<void> {
    this.finish()
    await waitForBrowserPageReady(pageId, this.asWebContents())
  }
}

export function createEligibilityFleet(native: Map<number, Electron.WebContents>, size = 33) {
  const manager = new BrowserManager()
  const attempts: string[] = []
  const freed: string[] = []
  const guests: EligibilityGuest[] = []
  const pageId = 'oldest'
  const send = (channel: string, payload: BrowserGuestDiscardProtectionChange): void => {
    if (channel === 'browser:guest-discard-protection-changed') {
      updateBrowserGuestProtection(payload)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main publication needs only this renderer's identity, liveness and send method.
  native.set(99, { id: 99, isDestroyed: () => false, send } as unknown as Electron.WebContents)
  const attach = (id: number): EligibilityGuest => {
    const guest = new EligibilityGuest(id)
    guests.push(guest)
    native.set(id, guest.asWebContents())
    const marker = prepareBrowserPageAttach(pageId, 99, 'persist:eligibility', guest.getURL())
    admitBrowserPageAttach(marker, 99, 'persist:eligibility')
    associateBrowserPageAttach(guest.asWebContents())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production pool reads only the fixture's native guest ID.
    registerBrowserGuestActivity(pageId, { getWebContentsId: () => id } as Electron.WebviewTag)
    manager.attachGuestPolicies(guest.asWebContents())
    manager.registerGuest({ browserPageId: pageId, webContentsId: id, rendererWebContentsId: 99 })
    startBrowserPageAttach(guest.asWebContents())
    return guest
  }
  const guest = attach(1)
  for (let i = 1; i < size; i++) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected sibling rows expose only identity and never enter native reservation.
    registerBrowserGuestActivity(`held-${i}`, {
      getWebContentsId: () => 1000 + i
    } as Electron.WebviewTag)
  }
  const stop = installBrowserGuestPageRetention({
    isBlocked: (id) => browserGuestActivity.get(id)?.protection !== 'discardable',
    discard: (id, _webview, guestId) => {
      attempts.push(id)
      const current = native.get(guestId)
      if (
        !current ||
        manager.isGuestMemoryProtected(id) ||
        !reserveBrowserPageDiscard(id, current)
      ) {
        return false
      }
      freed.push(id)
      manager.unregisterGuest(id, 'guest-destroyed')
      unregisterBrowserGuestActivity(id)
      return true
    }
  })
  return {
    manager,
    guest,
    pageId,
    attempts,
    freed,
    attach,
    close: () => {
      stop()
      manager.unregisterAll()
      for (const item of guests) {
        item.destroy()
      }
      browserGuestActivity.clear()
      native.clear()
    }
  }
}
