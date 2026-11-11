import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { invokeGuestDiscard } from './browser-guest-sync-reply-test-fixture'
import { DestroyedGuestTestContents } from './browser-manager-destroyed-guest-test-fixture'
import { browserManager } from '../browser-manager'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  closeBrowserMemoryPage,
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
import { registerBrowserGuestDiscardHandlers } from '../../../../ipc/browser/browser-guest-discard-ipc'
import type { BrowserGuestDiscardProtectionChange } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

vi.mock('../../../../../renderer/src/store', () => ({
  useAppStore: { getState: () => ({ settings: {}, browserAudiblePageIds: {} }) }
}))
vi.mock('../../../../../renderer/src/components/browser-pane/host-guest/webview-registry', () => ({
  isBrowserPageRendererRecoveryPending: () => false
}))
vi.mock('../../../../ipc/browser/browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: () => true
}))

// The renderer project owns these types; the main fixture executes the production veto.
const { browserPageVetoesGuestEviction } = await vi.importActual<{
  browserPageVetoesGuestEviction: (pageId: string) => boolean
}>('../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-eviction-veto')

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
    detach: () => {
      this.debugged = false
      this.debugger.emit('detach')
    },
    sendCommand: vi.fn(async (): Promise<void> => undefined)
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
    this.emit('did-finish-load')
    this.emit('did-stop-loading')
  }

  async finishRestore(pageId: string): Promise<void> {
    this.finish()
    await waitForBrowserPageReady(pageId, this.asWebContents())
  }
}

export function createEligibilityFleet(
  native: Map<number, Electron.WebContents>,
  size = 33,
  allMainOwned = false,
  discard?: (id: string, webview: Electron.WebviewTag, guestId: number) => boolean
) {
  const manager = browserManager
  registerBrowserGuestDiscardHandlers()
  const attempts: string[] = []
  const freed: string[] = []
  const guests: EligibilityGuest[] = []
  const pageIds = new Set<string>()
  const pageId = 'oldest'
  const send = (channel: string, payload: BrowserGuestDiscardProtectionChange): void => {
    if (channel === 'browser:guest-discard-protection-changed') {
      updateBrowserGuestProtection(payload)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main publication needs only this renderer's identity, liveness and send method.
  const renderer = { id: 99, isDestroyed: () => false, send } as unknown as Electron.WebContents
  native.set(99, renderer)
  const attach = (
    id: number,
    attachedPageId = pageId,
    rendererActivity = true
  ): EligibilityGuest => {
    const guest = new EligibilityGuest(id)
    guests.push(guest)
    pageIds.add(attachedPageId)
    native.set(id, guest.asWebContents())
    const marker = prepareBrowserPageAttach(
      attachedPageId,
      99,
      'persist:eligibility',
      guest.getURL()
    )
    admitBrowserPageAttach(marker, 99, 'persist:eligibility')
    associateBrowserPageAttach(guest.asWebContents())
    if (rendererActivity) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production pool reads only the fixture's native guest ID.
      registerBrowserGuestActivity(attachedPageId, {
        getWebContentsId: () => id
      } as Electron.WebviewTag)
    }
    manager.attachGuestPolicies(guest.asWebContents())
    manager.registerGuest({
      browserPageId: attachedPageId,
      webContentsId: id,
      rendererWebContentsId: 99
    })
    startBrowserPageAttach(guest.asWebContents())
    return guest
  }
  const guest = attach(1)
  for (let i = 1; i < size; i++) {
    if (allMainOwned) {
      attach(1000 + i, `held-${i}`)
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected sibling rows expose only identity and never enter native reservation.
    registerBrowserGuestActivity(`held-${i}`, {
      getWebContentsId: () => 1000 + i
    } as Electron.WebviewTag)
  }
  const stop = installBrowserGuestPageRetention({
    isBlocked: (id) =>
      browserGuestActivity.get(id)?.protection === undefined || browserPageVetoesGuestEviction(id),
    discard: (id, webview, guestId) => {
      attempts.push(id)
      const accepted = discard
        ? discard(id, webview, guestId)
        : invokeGuestDiscard(renderer, {
            browserPageId: id,
            webContentsId: guestId
          })
      if (!accepted) {
        return false
      }
      freed.push(id)
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
    guests,
    pageIds,
    attach,
    close: () => {
      stop()
      manager.unregisterAll()
      for (const item of guests) {
        item.destroy()
      }
      for (const id of pageIds) {
        closeBrowserMemoryPage(id)
      }
      browserGuestActivity.clear()
      native.clear()
    }
  }
}
