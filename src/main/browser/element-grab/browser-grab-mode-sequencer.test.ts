import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import { registerBrowserGrabHandlers } from '../../ipc/browser/browser-grab-ipc'
import {
  captureCleanBrowserPage,
  disposeGrabModeStateForPage,
  pagesWithPendingGrabWaits,
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
  const emitter = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    executeJavaScript: (script: string) =>
      new Promise((settle, fail) => scripts.push({ script, settle, fail })),
    executeJavaScriptInIsolatedWorld: () => held(frames),
    capturePage: () =>
      held(readbacks).then(() => ({
        isEmpty: () => false,
        toDataURL: () => CAPTURE.dataUrl,
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
  return { guest, emitter, scripts, frames, readbacks, run, listeners }
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

const capture = (page: FakeGuest, resolve: () => Electron.WebContents | null = () => page.guest) =>
  captureCleanBrowserPage('page-1', page.guest, resolve)
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

  const late = capture(page).capture
  await flush()
  page.run(TEARDOWN)
  await vi.advanceTimersByTimeAsync(600)
  await expect(late).resolves.toBeNull()
  expect(page.readbacks).toHaveLength(0)
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

  // Queued behind a held predecessor: one retired by its viewer, one by the host lifetime; neither runs a stage.
  const predecessor = capture(page)
  await flush()
  const byViewer = capture(page)
  const byLifetime = capture(page)
  byViewer.retire()
  await vi.advanceTimersByTimeAsync(10_000)
  await passStages(page)
  await expect(predecessor.capture).resolves.toBeNull()
  await expect(byViewer.capture).resolves.toBeNull()
  await expect(byLifetime.capture).resolves.toBeNull()
  expect(page.scripts).toHaveLength(0)
  expect(pagesWithPendingGrabWaits()).toEqual([])
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

it('IPC: a denied sender changes nothing, and an await for a voided arm is refused without ending the newer pick', async () => {
  const page = fakeGuest()
  vi.spyOn(browserManager, 'getAuthorizedGuest').mockImplementation((_id, senderId) =>
    senderId === 1 ? page.guest : null
  )
  const on = ipc('browser:setGrabMode', 1, { browserPageId: 'page-1', enabled: true })
  await flush()
  const attempt = { browserPageId: 'page-1', attemptId: 'a-1' }
  await expect(ipc('browser:captureCleanPage', 2, attempt)).resolves.toBeNull()
  await expect(
    ipc('browser:setGrabMode', 2, { browserPageId: 'page-1', enabled: false })
  ).resolves.toEqual({ ok: true })
  await expect(ipc('browser:captureCleanPage', 1, { browserPageId: 'page-1' })).resolves.toBeNull()
  page.run(ARM)
  const { armToken: staleToken } = (await on) as { armToken: string }
  expect(staleToken).toBeDefined()

  // That enable's token outlives a Draw and a newer pick; its late await gets nothing and sends no off.
  const draw = ipc('browser:captureCleanPage', 1, attempt)
  await passStages(page)
  await expect(draw).resolves.toEqual(CAPTURE)
  const newer = ipc('browser:setGrabMode', 1, { browserPageId: 'page-1', enabled: true })
  await flush()
  page.run(ARM)
  const { armToken } = (await newer) as { armToken: string }
  void ipc('browser:awaitGrabSelection', 1, { browserPageId: 'page-1', opId: 'new', armToken })
  await flush()
  const pending = page.scripts.length
  await expect(
    ipc('browser:awaitGrabSelection', 1, {
      browserPageId: 'page-1',
      opId: 'old',
      armToken: staleToken
    })
  ).resolves.toEqual({ opId: 'old', kind: 'cancelled', reason: 'user' })
  expect(browserManager.hasActiveGrabOp('page-1')).toBe(true)
  expect(page.scripts).toHaveLength(pending)
})
