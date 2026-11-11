import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  waitForBrowserPageReady,
  reserveBrowserPageDiscard,
  claimBrowserMemoryPage,
  retainBrowserMemoryPageForAgent,
  closeBrowserMemoryPage,
  isRetiredBrowserGuest,
  acknowledgeBrowserPageRemoval,
  browserMemoryGeneration
} from './browser-page-memory'

const { caller, throttle } = vi.hoisted(() => ({
  caller: { agent: false },
  throttle: vi.fn(() => vi.fn())
}))
vi.mock('../../runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: caller.agent ? 'local-cli' : 'desktop' })
}))
vi.mock('../../window/renderer-publication-throttle', () => ({
  rendererPublicationThrottle: { acquire: throttle }
}))
vi.mock('./manager/registration/browser-guest-discard-protection', () => ({
  markInitialBrowserGuest: vi.fn(),
  readBrowserGuestDiscardProtection: () => ({ protection: 'discardable' })
}))
const pageId = 'memory-page'
afterEach(() => {
  closeBrowserMemoryPage(pageId)
  caller.agent = false
  throttle.mockClear()
})
function attach(id: number, partition = 'persist:profile') {
  const marker = prepareBrowserPageAttach(pageId, 99, partition, 'https://example.test/b')
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
    isDestroyed: () => destroyed,
    isLoading: () => false,
    isDevToolsOpened: () => false,
    debugger: { isAttached: () => false },
    loadURL: vi.fn(() => load),
    navigationHistory: {
      getAllEntries: () => [
        { url: 'https://example.test/a', title: 'A', pageState: 'fixture-opaque-state' },
        { url: 'https://example.test/b', title: 'B', pageState: 'fixture-opaque-state' }
      ],
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
  return { guest, finishLoad, failLoad, marker }
}

it('keeps the cold identity/history, gates every consumer on load and fences retiring G from H', async () => {
  const first = attach(1)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  const generation = browserMemoryGeneration(pageId)
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
  expect(isRetiredBrowserGuest(pageId, 1)).toBe(true)
  const second = attach(2)
  const action = vi.fn()
  const pending = waitForBrowserPageReady(pageId, second.guest).then(action)
  await Promise.resolve()
  expect(action).not.toHaveBeenCalled()
  expect(second.guest.navigationHistory.restore).toHaveBeenCalledWith({
    entries: [
      { url: 'https://example.test/a', title: 'A' },
      { url: 'https://example.test/b', title: 'B' }
    ],
    index: 1
  })
  second.finishLoad()
  await pending
  expect(action).toHaveBeenCalledOnce()
  expect(browserMemoryGeneration(pageId)).toBe(generation)
  expect(reserveBrowserPageDiscard(pageId, second.guest)).toBe(false)
  await acknowledgeBrowserPageRemoval(pageId, first.guest, 99)
  expect(second.guest.isDestroyed()).toBe(false)
  expect(reserveBrowserPageDiscard(pageId, second.guest)).toBe(true)
})

it('keeps agent holds unthrottled across replacement and closes their exact lease once', async () => {
  const first = attach(3)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  caller.agent = true
  claimBrowserMemoryPage(pageId)()
  claimBrowserMemoryPage(pageId)()
  expect(throttle).toHaveBeenCalledOnce()
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(false)
  first.guest.close()
  expect(throttle.mock.results[0].value).toHaveBeenCalledOnce()
  const second = attach(4)
  second.finishLoad()
  await waitForBrowserPageReady(pageId, second.guest)
  expect(throttle).toHaveBeenCalledTimes(2)
  expect(reserveBrowserPageDiscard(pageId, second.guest)).toBe(false)
  closeBrowserMemoryPage(pageId)
  expect(throttle.mock.results[1].value).toHaveBeenCalledOnce()
})

it('returns a normal load failure, admits recovery and rejects marker reuse', async () => {
  const first = attach(5)
  const action = vi.fn()
  const result = waitForBrowserPageReady(pageId, first.guest).then(action)
  first.failLoad(new Error('Offline'))
  await expect(result).rejects.toThrow('Offline')
  expect(action).not.toHaveBeenCalled()
  expect(() => admitBrowserPageAttach(first.marker, 99, 'persist:profile')).toThrow()
  await Promise.resolve()
  await expect(waitForBrowserPageReady(pageId, first.guest)).resolves.toBeUndefined()
})

it('keeps the agent hold on an intentional profile replacement without replaying the old profile history', async () => {
  const first = attach(6)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  caller.agent = true
  claimBrowserMemoryPage(pageId)()
  const second = attach(7, 'persist:other')
  second.finishLoad()
  await waitForBrowserPageReady(pageId, second.guest)
  expect(second.guest.navigationHistory.restore).not.toHaveBeenCalled()
  expect(second.guest.loadURL).toHaveBeenCalledWith('https://example.test/b')
  expect(reserveBrowserPageDiscard(pageId, second.guest)).toBe(false)
})

it('waits through an aborted initial navigation for its replacement document', async () => {
  const first = attach(8)
  const action = vi.fn()
  const pending = waitForBrowserPageReady(pageId, first.guest).then(action)
  first.failLoad(Object.assign(new Error('ERR_ABORTED'), { errno: -3 }))
  await Promise.resolve()
  expect(action).not.toHaveBeenCalled()
  first.guest.emit('did-finish-load')
  await pending
  expect(action).toHaveBeenCalledOnce()
})

it('preserves failed cold history for normal reload recovery instead of poisoning subsequent commands', async () => {
  const first = attach(9)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
  const second = attach(10)
  const failed = waitForBrowserPageReady(pageId, second.guest)
  second.failLoad(new Error('Offline'))
  await expect(failed).rejects.toThrow('Offline')
  await Promise.resolve()
  await expect(waitForBrowserPageReady(pageId, second.guest)).rejects.toThrow(
    'could not be restored'
  )
  await expect(waitForBrowserPageReady(pageId, second.guest, true)).resolves.toBeUndefined()
  second.guest.emit('did-finish-load')
  await expect(waitForBrowserPageReady(pageId, second.guest)).resolves.toBeUndefined()
})

it('does not carry an invalid page selector into the lifetime of a later real page', async () => {
  caller.agent = true
  claimBrowserMemoryPage(pageId)()
  caller.agent = false
  const first = attach(11)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
})

it('does not leave an agent hold for an untracked popup after its operation ends', async () => {
  caller.agent = true
  const release = claimBrowserMemoryPage(pageId)
  retainBrowserMemoryPageForAgent(pageId)
  release()
  caller.agent = false
  const first = attach(12)
  first.finishLoad()
  await waitForBrowserPageReady(pageId, first.guest)
  expect(reserveBrowserPageDiscard(pageId, first.guest)).toBe(true)
})
