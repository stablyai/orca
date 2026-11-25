import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  waitForBrowserPageReady,
  reserveBrowserPageDiscard,
  closeBrowserMemoryPage
} from './browser-page-memory'

const { caller, throttle } = vi.hoisted(() => ({
  caller: { agent: false },
  throttle: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/rpc/callers/active-call', () => ({
  getActiveRpcCaller: () => ({ kind: caller.agent ? 'local-cli' : 'desktop' })
}))
vi.mock('../../window/visibility/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: throttle }
}))
vi.mock('./manager/registration/browser-guest-discard-protection', () => ({
  readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
}))
function startNavigation(guest: Electron.WebContents, url = 'https://example.test/b'): void {
  guest.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true })
}
const pageId = 'memory-page'
afterEach(() => {
  closeBrowserMemoryPage(pageId)
  vi.useRealTimers()
  caller.agent = false
  throttle.mockClear()
})
function attach(
  id: number,
  partition = 'persist:profile',
  url = 'https://example.test/b',
  entries = [
    { url: 'https://example.test/a', title: 'A', pageState: 'fixture-opaque-state' },
    { url: 'https://example.test/b', title: 'B', pageState: 'fixture-opaque-state' }
  ],
  marker = prepareBrowserPageAttach(pageId, 99, partition, url)
) {
  admitBrowserPageAttach(marker, 99, partition)
  let finishLoad: () => void = () => {}
  let failLoad: (error: Error) => void = () => {}
  const load = new Promise<void>((resolve, reject) => {
    finishLoad = resolve
    failLoad = reject
  })
  let destroyed = false
  const events = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deterministic native event and load fixture.
  const guest = Object.assign(events, {
    id,
    hostWebContents: { id: 99 },
    getType: () => 'webview',
    getURL: () => url,
    isDestroyed: () => destroyed,
    isLoading: () => false,
    isLoadingMainFrame: () => false,
    isDevToolsOpened: () => false,
    debugger: { isAttached: () => false },
    loadURL: vi.fn(() => load),
    navigationHistory: {
      getAllEntries: () => entries,
      getEntryAtIndex: () => ({ pageState: 'BAAAACgAAAA=' }),
      getActiveIndex: () => 1,
      restore: vi.fn(() => load)
    },
    close: () => {
      destroyed = true
      events.emit('destroyed')
    }
  }) as unknown as Electron.WebContents
  associateBrowserPageAttach(guest)
  startBrowserPageAttach(guest)
  startNavigation(guest)
  const resolveLoad = finishLoad
  return {
    guest,
    finishLoad: () => {
      guest.emit('did-navigate', {}, 'https://example.test/b')
      guest.emit('did-finish-load')
      resolveLoad()
    },
    settleLoad: resolveLoad,
    failLoad,
    marker
  }
}

it('delivers the authorized private attach once and strips native history before cold restore', async () => {
  const raw = 'https://kagi.com/search?q=one&token=attach-secret'
  const first = attach(81, 'persist:profile', raw, [
    { url: 'https://example.test/a', title: 'A', pageState: 'opaque-referrer' },
    { url: raw, title: raw, pageState: 'opaque-private-state' }
  ])
  expect(first.guest.loadURL).toHaveBeenCalledWith(raw)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
  const second = attach(82)
  expect(second.guest.navigationHistory.restore).toHaveBeenCalledWith({
    entries: [
      { url: 'https://example.test/a', title: 'A' },
      { url: 'https://kagi.com/search?q=one', title: 'https://kagi.com/search?q=one' }
    ],
    index: 1
  })
  second.finishLoad()
  await waitForBrowserPageReady(pageId, second.guest)
})

it('expires an unmounted private attach without replaying its bearer and rejects other owners', async () => {
  vi.useFakeTimers()
  const marker = prepareBrowserPageAttach(
    pageId,
    99,
    'persist:profile',
    'https://kagi.com/search?q=one&token=expired-secret'
  )
  expect(() => admitBrowserPageAttach(marker, 100, 'persist:profile')).toThrow(
    'Invalid browser page attach'
  )
  expect(() => admitBrowserPageAttach(marker, 99, 'persist:other')).toThrow(
    'Invalid browser page attach'
  )
  vi.advanceTimersByTime(300_001)
  const cold = attach(83, 'persist:profile', '', undefined, marker)
  expect(cold.guest.loadURL).toHaveBeenCalledWith('https://kagi.com/search?q=one')
  cold.finishLoad()
  await waitForBrowserPageReady(pageId, cold.guest)
})

it('returns a safe private attach failure while keeping ordinary load diagnostics', async () => {
  const raw = 'https://kagi.com/search?q=one&token=error-secret'
  const first = attach(84, 'persist:profile', raw)
  const pending = waitForBrowserPageReady(pageId, first.guest)
  first.failLoad(Object.assign(new Error(`ERR_FAILED ${raw}`), { url: raw }))
  await expect(pending).rejects.toThrow('Private navigation failed.')
})
