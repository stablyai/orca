import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  reserveBrowserPageDiscard,
  waitForBrowserPageReady,
  acknowledgeBrowserPageRemoval,
  closeBrowserMemoryPage
} from '../../browser-page-memory'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection
} from './browser-guest-discard-protection'
import { reportBrowserSessionWebRequest } from '../../../sessions/requests/browser-session-web-request-observer'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

vi.mock('../../../../runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: 'desktop' })
}))
vi.mock('../../../../window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: vi.fn(() => vi.fn()) }
}))

it.each(['edited', 'POST', 'unknown'])(
  'retains %s history accumulated before restored load finishes',
  async (obligation) => {
    const pageId = 'restore-history-page'
    const stops: (() => void)[] = []
    let nextRequest = 0
    const attach = (id: number) => {
      const marker = prepareBrowserPageAttach(
        pageId,
        99,
        'persist:profile',
        'https://example.test/a'
      )
      admitBrowserPageAttach(marker, 99, 'persist:profile')
      let destroyed = false
      let length = 2
      const mainFrame = { frames: [], send: vi.fn<(channel: string, generation: string) => void>() }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event fixture implements the real attach and protection owners' native surfaces.
      const guest = Object.assign(new EventEmitter(), {
        id,
        mainFrame,
        session: {},
        hostWebContents: { id: 99 },
        getType: () => 'webview',
        isDestroyed: () => destroyed,
        isCrashed: () => false,
        isCurrentlyAudible: () => false,
        isLoading: () => false,
        isDevToolsOpened: () => false,
        debugger: { isAttached: () => false },
        loadURL: () => new Promise<void>(() => {}),
        navigationHistory: {
          length: () => length,
          getActiveIndex: () => length - 1,
          getAllEntries: () => [
            { url: 'https://example.test/prior', title: 'Prior' },
            { url: 'https://example.test/a', title: 'A' }
          ],
          restore: vi.fn(() => new Promise<void>(() => {}))
        },
        close: () => {
          destroyed = true
          guest.emit('destroyed')
        }
      }) as unknown as Electron.WebContents
      expect(associateBrowserPageAttach(guest)).toBe(true)
      stops.push(installBrowserGuestDiscardProtection(guest, () => {}))
      startBrowserPageAttach(guest)
      const report = (dirty: boolean): void => {
        guest.emit(
          'ipc-message',
          { sender: guest, senderFrame: mainFrame },
          BROWSER_GUEST_PROTECTION_REPORT,
          { generation: mainFrame.send.mock.lastCall?.[1], dirty }
        )
      }
      const navigate = (url: string, method = 'GET', completed = true): void => {
        guest.emit('did-start-navigation', {
          url,
          frame: mainFrame,
          isMainFrame: true,
          isSameDocument: false
        })
        const details = {
          id: ++nextRequest,
          url,
          method,
          frame: guest.mainFrame,
          resourceType: 'mainFrame',
          webContentsId: id,
          timestamp: 0
        }
        reportBrowserSessionWebRequest(guest.session, 'onBeforeRequest', details)
        guest.emit('did-navigate', {}, url)
        if (completed) {
          reportBrowserSessionWebRequest(guest.session, 'onCompleted', details)
        }
        guest.emit('dom-ready')
        report(false)
      }
      return {
        guest,
        report,
        navigate,
        sole: () => {
          length = 1
        }
      }
    }
    try {
      const first = attach(71)
      first.navigate('https://example.test/a')
      first.guest.emit('did-finish-load')
      await waitForBrowserPageReady(pageId, first.guest)
      expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
      await acknowledgeBrowserPageRemoval(pageId, first.guest, 99)
      const restored = attach(72)
      expect(restored.guest.navigationHistory.restore).toHaveBeenCalledWith({
        entries: [
          { url: 'https://example.test/prior', title: 'Prior' },
          { url: 'https://example.test/a', title: 'A' }
        ],
        index: 1
      })
      restored.navigate(
        'https://example.test/a',
        obligation === 'POST' ? 'POST' : 'GET',
        obligation !== 'unknown'
      )
      if (obligation === 'edited') {
        restored.report(true)
      }
      restored.navigate('https://example.test/b')
      // The first finish event can belong to B, after A was edited or committed unsafely.
      restored.guest.emit('did-finish-load')
      await waitForBrowserPageReady(pageId, restored.guest)
      expect(readBrowserGuestDiscardProtection(restored.guest).reason).toBe('history')
      expect(reserveBrowserPageDiscard(pageId, restored.guest)).toBe(false)
      restored.sole()
      restored.navigate('https://example.test/sole-clean')
      expect(readBrowserGuestDiscardProtection(restored.guest).protection).toBe('discardable')
    } finally {
      stops.forEach((stop) => stop())
      closeBrowserMemoryPage(pageId)
    }
  }
)
