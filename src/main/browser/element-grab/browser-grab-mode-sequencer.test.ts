import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import { registerBrowserGrabHandlers } from '../../ipc/browser/browser-grab-ipc'
import {
  captureCleanBrowserPage,
  disposeGrabModeStateForPage,
  pagesWithPendingGrabWaits,
  queuedGrabModeOperationCount,
  resetGrabModeState,
  setBrowserGrabMode
} from './browser-grab-mode-sequencer'
import { buildGuestOverlayScript } from './grab-guest-script'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))
vi.mock('../../ipc/browser/browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: () => true
}))

const TEARDOWN = buildGuestOverlayScript('teardown')
const ARM = buildGuestOverlayScript('arm')
const CAPTURE = { dataUrl: 'data:image/png;base64,AA==', width: 2, height: 1 }
const WATCHED = ['did-start-navigation', 'render-process-gone', 'destroyed', 'did-stop-loading']

type Held = { settle: (value: unknown) => void; fail: (error: Error) => void }
const held = (into: Held[]): Promise<unknown> =>
  new Promise((settle, fail) => into.push({ settle, fail }))

/** Every page call stays pending until the test settles it, like a page that hasn't run it yet. */
function fakeGuest(loading = false) {
  const scripts: (Held & { script: string })[] = []
  const frames: Held[] = []
  const readbacks: Held[] = []
  const state = { loading, onEncode: () => {} }
  const emitter = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    isLoadingMainFrame: () => state.loading,
    executeJavaScript: (script: string) =>
      new Promise((settle, fail) => scripts.push({ script, settle, fail })),
    executeJavaScriptInIsolatedWorld: () => held(frames),
    capturePage: () =>
      held(readbacks).then(() => ({
        isEmpty: () => false,
        toDataURL: () => {
          state.onEncode()
          return CAPTURE.dataUrl
        },
        getSize: () => ({ width: 2, height: 1 })
      }))
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grab mode and clean capture only call the script, load, capture and event members this fake implements.
  const guest = emitter as unknown as Electron.WebContents
  const run = (script: string): void => {
    for (const call of scripts.filter((entry) => entry.script === script)) {
      scripts.splice(scripts.indexOf(call), 1)
      call.settle(true)
    }
  }
  const listeners = (): number =>
    WATCHED.reduce((sum, name) => sum + emitter.listenerCount(name), 0)
  return { guest, emitter, scripts, frames, readbacks, state, run, listeners }
}
type FakeGuest = ReturnType<typeof fakeGuest>

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

async function armedGuest(pageId = 'page-1'): Promise<FakeGuest> {
  const page = fakeGuest()
  const on = setBrowserGrabMode(pageId, true, () => page.guest)
  await flush()
  page.run(ARM)
  await on
  return page
}

/** Releases a clean capture's teardown and frame barrier; the readback stays held unless `readback`. */
async function passStages(page: FakeGuest, readback = true): Promise<void> {
  await flush()
  page.run(TEARDOWN)
  await flush()
  page.frames.shift()?.settle(true)
  await flush()
  if (readback) {
    page.readbacks.shift()?.settle(true)
    await flush()
  }
}

const capture = (
  page: FakeGuest,
  resolve: () => Electron.WebContents | null = () => page.guest,
  deadlineMs = Date.now() + 10_000
) => captureCleanBrowserPage('page-1', page.guest, resolve, deadlineMs)!
const ipc = (channel: string, senderId: number, args: unknown): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)!({ sender: { id: senderId } }, args))

beforeEach(() => registerBrowserGrabHandlers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetGrabModeState()
})

it('turning grab off during a pick settles only after the page ran the teardown', async () => {
  const page = await armedGuest()
  void browserManager.awaitGrabSelection('page-1', 'op-1', page.guest)
  let settled: unknown = null
  void setBrowserGrabMode('page-1', false, () => page.guest).then((result) => (settled = result))
  await flush()
  expect(settled).toBeNull()
  page.run(TEARDOWN)
  await flush()
  expect(settled).toEqual({ ok: true })
})

it('a superseded disable says so; a never-armed loading page is turned off at once and keeps no wait', async () => {
  const page = await armedGuest()
  const off = setBrowserGrabMode('page-1', false, () => page.guest)
  void setBrowserGrabMode('page-1', true, () => page.guest)
  await expect(off).resolves.toEqual({ ok: true, superseded: true })

  const loading = fakeGuest(true)
  const on = setBrowserGrabMode('page-2', true, () => loading.guest)
  await flush()
  await expect(setBrowserGrabMode('page-2', false, () => loading.guest)).resolves.toEqual({
    ok: true
  })
  await expect(on).resolves.toEqual({ ok: true, superseded: true })
  expect(loading.scripts).toHaveLength(0)

  const destroyed = fakeGuest(true)
  let alive = true
  void setBrowserGrabMode('page-3', true, () => (alive ? destroyed.guest : null))
  await flush()
  alive = false
  destroyed.emitter.emit('destroyed')
  await flush()
  expect(pagesWithPendingGrabWaits()).toEqual([])
  expect(destroyed.listeners()).toBe(0)
})

it('clean capture holds each stage in turn, needs an affirmative frame barrier, and any arm waits behind it', async () => {
  vi.useFakeTimers()
  const page = await armedGuest()
  const clean = capture(page).capture
  await flush()
  expect(page.frames).toHaveLength(0)
  page.run(TEARDOWN)
  await flush()
  const streamedArm = setBrowserGrabMode('page-1', true, () => page.guest)
  page.frames.shift()!.settle(true)
  await flush()
  expect(page.scripts).toHaveLength(0)
  page.readbacks.shift()!.settle(true)
  await expect(clean).resolves.toEqual(CAPTURE)
  await flush()
  page.run(ARM)
  await expect(streamedArm).resolves.toMatchObject({ ok: true })

  const rejected = capture(page).capture
  await flush()
  page.run(TEARDOWN)
  await flush()
  page.frames.shift()!.fail(new Error('frame gone'))
  await expect(rejected).resolves.toBeNull()

  // A stalled probe is never stacked: retries fail fast until it settles, then the next one captures.
  const late = capture(page).capture
  await flush()
  page.run(TEARDOWN)
  await vi.advanceTimersByTimeAsync(600)
  await expect(late).resolves.toBeNull()
  const retry = capture(page).capture
  await flush()
  page.run(TEARDOWN)
  await expect(retry).resolves.toBeNull()
  expect(page.frames).toHaveLength(1)
  page.frames.shift()!.settle(true)
  await flush()
  const recovered = capture(page).capture
  await passStages(page)
  await expect(recovered).resolves.toEqual(CAPTURE)

  // Encoding a large page can outlast the deadline; the image is then never returned.
  const encoded = capture(page, () => page.guest, Date.now() + 1_000).capture
  page.state.onEncode = () => vi.setSystemTime(Date.now() + 2_000)
  await passStages(page)
  await expect(encoded).resolves.toBeNull()
  expect(page.listeners()).toBe(0)
})

it('a retired attempt skips stages not yet started but holds the queue until its readback settles', async () => {
  vi.useFakeTimers()
  const page = await armedGuest()
  const first = capture(page)
  await passStages(page, false)
  first.retire()
  const arm = setBrowserGrabMode('page-1', true, () => page.guest)
  await flush()
  expect(page.scripts).toHaveLength(0)
  page.readbacks.shift()!.settle(true)
  await expect(first.capture).resolves.toBeNull()
  await flush()
  page.run(ARM)
  await arm
})

it('each way a queued follower ends releases it at once while the head stays held, and a retry then captures', async () => {
  vi.useFakeTimers()
  const triggers = ['retire', 'deadline', 'crash', 'navigation', 'dispose'] as const
  for (const trigger of triggers) {
    const page = await armedGuest()
    const head = capture(page)
    await passStages(page, false)
    const headOnly = { listeners: page.listeners(), timers: vi.getTimerCount() }
    const follower = capture(page, () => page.guest, Date.now() + 1_000)
    expect(queuedGrabModeOperationCount()).toBe(1)
    if (trigger === 'retire') {
      follower.retire()
    } else if (trigger === 'deadline') {
      await vi.advanceTimersByTimeAsync(1_000)
    } else if (trigger === 'crash') {
      page.emitter.emit('render-process-gone')
    } else if (trigger === 'navigation') {
      page.emitter.emit('did-start-navigation', {}, 'https://same.test/', false, true)
    } else {
      disposeGrabModeStateForPage('page-1')
    }
    // Released before the head is: nothing of the follower is queued, watched or timed any more.
    await expect(follower.capture).resolves.toBeNull()
    expect(queuedGrabModeOperationCount()).toBe(0)
    expect(page.listeners()).toBe(headOnly.listeners)
    expect(vi.getTimerCount()).toBe(headOnly.timers)

    // A successor admitted after disposal keeps its own entries when the old head cleans up.
    const retry = capture(page)
    page.readbacks.shift()!.settle(true)
    const headEndsClean = trigger === 'retire' || trigger === 'deadline'
    await expect(head.capture).resolves.toEqual(headEndsClean ? CAPTURE : null)
    expect(pagesWithPendingGrabWaits()).toEqual(['page-1'])
    await passStages(page)
    await expect(retry.capture).resolves.toEqual(CAPTURE)
    expect(pagesWithPendingGrabWaits()).toEqual([])
    expect(page.listeners()).toBe(0)
  }
})

it('a queued capture refuses a same-URL reload or a disposed page, and never touches a successor guest', async () => {
  const page = await armedGuest()
  const blocker = capture(page)
  const reloaded = capture(page)
  page.emitter.emit('did-start-navigation', {}, 'https://same.test/', false, true)
  await passStages(page)
  await expect(blocker.capture).resolves.toBeNull()
  await expect(reloaded.capture).resolves.toBeNull()
  expect(page.scripts).toHaveLength(0)

  const old = await armedGuest()
  const successor = fakeGuest()
  let current = old.guest
  const first = capture(old, () => current)
  const queued = capture(old, () => current)
  await flush()
  disposeGrabModeStateForPage('page-1')
  current = successor.guest
  old.run(TEARDOWN)
  await expect(first.capture).resolves.toBeNull()
  await expect(queued.capture).resolves.toBeNull()
  expect(successor.scripts).toHaveLength(0)
  expect(old.listeners() + successor.listeners()).toBe(0)
})

it('a never-armed page is captured at once even with its frames stalled; an armed one owes teardown and paint', async () => {
  vi.useFakeTimers()
  const idle = fakeGuest()
  const direct = capture(idle).capture
  await flush()
  idle.readbacks.shift()!.settle(true)
  await expect(direct).resolves.toEqual(CAPTURE)
  expect(idle.scripts).toHaveLength(0)
  expect(idle.frames).toHaveLength(0)

  const armed = await armedGuest()
  const stalled = capture(armed).capture
  await flush()
  armed.run(TEARDOWN)
  await vi.advanceTimersByTimeAsync(600)
  await expect(stalled).resolves.toBeNull()
  expect(armed.readbacks).toHaveLength(0)
  // Still owed: the next capture probes again (the stalled probe is still pending, so it refuses until it settles).
  armed.frames.shift()!.settle(true)
  await flush()
  const proven = capture(armed).capture
  await flush()
  expect(armed.frames).toHaveLength(1)
  armed.frames.shift()!.settle(true)
  await flush()
  armed.readbacks.shift()!.settle(true)
  await expect(proven).resolves.toEqual(CAPTURE)
  // Once a frame without the overlay was seen, later captures go straight to the readback.
  const after = capture(armed).capture
  await flush()
  armed.readbacks.shift()!.settle(true)
  await expect(after).resolves.toEqual(CAPTURE)
  expect(armed.frames).toHaveLength(0)
})

it('a throwing paint hold or release leaks no document listeners', async () => {
  const page = await armedGuest()
  vi.spyOn(browserManager, 'holdPaintForCapture').mockImplementationOnce(() => {
    throw new Error('hold failed')
  })
  await expect(capture(page).capture).resolves.toBeNull()
  vi.spyOn(browserManager, 'holdPaintForCapture').mockImplementationOnce(() => () => {
    throw new Error('release failed')
  })
  const released = capture(page).capture
  await passStages(page)
  await expect(released).resolves.toBeNull()
  expect(page.listeners()).toBe(0)
})

it('IPC: only the authorized guest the request began on, settled and in time, gets a capture; nothing else changes the page', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const page = fakeGuest()
  let validationTakesMs = 0
  vi.spyOn(browserManager, 'getAuthorizedGuest').mockImplementation((_id, senderId) => {
    vi.setSystemTime(Date.now() + validationTakesMs)
    return senderId === 1 ? page.guest : null
  })
  const on = ipc('browser:setGrabMode', 1, { browserPageId: 'page-1', enabled: true })
  await flush()
  const attempt = (overrides: object = {}) => ({
    browserPageId: 'page-1',
    attemptId: 'a-1',
    guestId: 7,
    deadlineMs: Date.now() + 10_000,
    ...overrides
  })
  const refused = async (senderId: number, args: unknown): Promise<void> => {
    await expect(ipc('browser:captureCleanPage', senderId, args)).resolves.toBeNull()
  }
  page.state.loading = true
  // A load that started before Draw, even to the same URL, is not the document Draw was asked for.
  await refused(1, attempt())
  page.state.loading = false
  await refused(2, attempt())
  await refused(1, attempt({ guestId: 8 }))
  await refused(1, attempt({ guestId: undefined }))
  await refused(1, { browserPageId: 'page-1', attemptId: 'a-1' })
  await refused(1, attempt({ deadlineMs: Date.now() }))
  await refused(1, attempt({ deadlineMs: Date.now() - 1 }))
  // Still in time on arrival, but due by the time validation finishes: the clock is read again at admission.
  validationTakesMs = 20
  await refused(1, attempt({ deadlineMs: Date.now() + 10 }))
  validationTakesMs = 0
  page.run(ARM)
  await expect(on).resolves.toEqual({ ok: true })
  expect(page.scripts).toHaveLength(0)

  const draw = ipc('browser:captureCleanPage', 1, attempt())
  await passStages(page)
  await expect(draw).resolves.toEqual(CAPTURE)

  // A far-future deadline is clamped to the host maximum; crossing it inside the synchronous encode, where no
  // timer can run, still returns nothing.
  const overlong = ipc('browser:captureCleanPage', 1, attempt({ deadlineMs: Date.now() + 1e9 }))
  page.state.onEncode = () => vi.setSystemTime(Date.now() + 10_001)
  await passStages(page)
  await expect(overlong).resolves.toBeNull()
  page.state.onEncode = () => {}
  const healthy = ipc('browser:captureCleanPage', 1, attempt())
  await passStages(page)
  await expect(healthy).resolves.toEqual(CAPTURE)
})
