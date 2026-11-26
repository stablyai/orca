import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import {
  captureCleanBrowserPage,
  resetGrabModeState,
  setBrowserGrabMode
} from './browser-grab-mode-sequencer'
import { buildGuestOverlayScript } from './grab-guest-script'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

const TEARDOWN = buildGuestOverlayScript('teardown')
const ARM = buildGuestOverlayScript('arm')

/** Each executeJavaScript call stays pending until the test settles it, like a page that hasn't run it yet. */
function fakeGuest(loading = false) {
  const calls: { script: string; settle: (value: unknown) => void }[] = []
  const frames: { settle: (value: unknown) => void; fail: (error: Error) => void }[] = []
  const state = { loading, captures: 0 }
  const emitter = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    isLoadingMainFrame: () => state.loading,
    executeJavaScript: (script: string) => new Promise((settle) => calls.push({ script, settle })),
    executeJavaScriptInIsolatedWorld: () =>
      new Promise((settle, fail) => frames.push({ settle, fail })),
    capturePage: async () => {
      state.captures += 1
      return {
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,AA==',
        getSize: () => ({ width: 2, height: 1 })
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grab mode and clean capture only call the script, load, capture and event members this fake implements.
  const guest = emitter as unknown as Electron.WebContents
  const stopLoading = (): void => {
    state.loading = false
    emitter.emit('did-stop-loading')
  }
  // The page runs every queued script in order, as Electron does for one world.
  const runScripts = (): void => calls.splice(0).forEach((call) => call.settle(true))
  return { guest, calls, frames, state, stopLoading, runScripts, emitter }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

afterEach(() => resetGrabModeState())

it('turning grab off during a pick settles only after the page ran the teardown', async () => {
  const { guest, calls } = fakeGuest()
  void browserManager.awaitGrabSelection('page-1', 'op-1', guest)
  let settled: unknown = null
  void setBrowserGrabMode('page-1', false, () => guest).then((result) => (settled = result))
  await flush()
  expect(settled).toBeNull()
  for (const call of calls.filter((entry) => entry.script === TEARDOWN)) {
    call.settle(true)
  }
  await flush()
  expect(settled).toEqual({ ok: true })
})

it('a disable that a newer enable overtook reports superseded, not a clean page', async () => {
  const { guest, calls } = fakeGuest()
  const off = setBrowserGrabMode('page-1', false, () => guest)
  const on = setBrowserGrabMode('page-1', true, () => guest)
  await flush()
  calls.forEach((call) => call.settle(true))
  await flush()
  calls.forEach((call) => call.settle(true))
  await expect(off).resolves.toEqual({ ok: true, superseded: true })
  await expect(on).resolves.toEqual({ ok: true })
})

it('an arm waiting for a loading page yields to a later disable without ever arming', async () => {
  const { guest, calls, stopLoading } = fakeGuest(true)
  const on = setBrowserGrabMode('page-1', true, () => guest)
  await flush()
  const off = setBrowserGrabMode('page-1', false, () => guest)
  await expect(on).resolves.toEqual({ ok: true, superseded: true })
  await flush()
  stopLoading()
  calls.forEach((call) => call.settle(true))
  await expect(off).resolves.toEqual({ ok: true })
  expect(calls.map((call) => call.script)).not.toContain(ARM)
})

const CAPTURE = { dataUrl: 'data:image/png;base64,AA==', width: 2, height: 1 }

it('captures only after the teardown ran and two frames painted; a rejected or late frame barrier captures nothing', async () => {
  vi.useFakeTimers()
  try {
    const { guest, frames, state, runScripts } = fakeGuest()
    const capture = captureCleanBrowserPage('page-1', () => guest)
    await flush()
    expect(frames).toHaveLength(0)
    runScripts()
    await flush()
    expect(state.captures).toBe(0)
    frames.shift()!.settle(true)
    await expect(capture).resolves.toEqual(CAPTURE)

    const rejected = captureCleanBrowserPage('page-1', () => guest)
    await flush()
    runScripts()
    await flush()
    frames.shift()!.fail(new Error('frame gone'))
    await expect(rejected).resolves.toBeNull()

    const late = captureCleanBrowserPage('page-1', () => guest)
    await flush()
    runScripts()
    await flush()
    await vi.advanceTimersByTimeAsync(600)
    await expect(late).resolves.toBeNull()
    expect(state.captures).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

it('a streamed viewer re-arming during the frame wait arms only after the clean capture', async () => {
  const { guest, calls, frames, state, runScripts } = fakeGuest()
  const capture = captureCleanBrowserPage('page-1', () => guest)
  await flush()
  runScripts()
  await flush()
  const streamedArm = setBrowserGrabMode('page-1', true, () => guest)
  await flush()
  expect(calls.map((call) => call.script)).not.toContain(ARM)
  frames.shift()!.settle(true)
  await expect(capture).resolves.toEqual(CAPTURE)
  expect(state.captures).toBe(1)
  await flush()
  expect(calls.map((call) => call.script)).toContain(ARM)
  runScripts()
  await expect(streamedArm).resolves.toEqual({ ok: true })
})

it('a reload or a retired viewer during the frame wait captures nothing', async () => {
  const { guest, frames, state, runScripts, emitter } = fakeGuest()
  const reload = captureCleanBrowserPage('page-1', () => guest)
  await flush()
  runScripts()
  await flush()
  emitter.emit('did-start-navigation', {}, 'https://same.test/', false, true)
  frames.shift()!.settle(true)
  await expect(reload).resolves.toBeNull()

  let viewerLive = true
  const retired = captureCleanBrowserPage('page-1', () => (viewerLive ? guest : null))
  await flush()
  runScripts()
  await flush()
  viewerLive = false
  frames.shift()!.settle(true)
  await expect(retired).resolves.toBeNull()
  expect(state.captures).toBe(0)
})

it('a failed teardown captures nothing, and a retry or an auto-cancelled pick still runs the teardown', async () => {
  const { guest, calls, frames, state } = fakeGuest()
  const failed = captureCleanBrowserPage('page-1', () => guest)
  await flush()
  // A rejected script is how Electron reports a teardown that never ran.
  calls.splice(0).forEach((call) => call.settle(Promise.reject(new Error('page busy'))))
  await expect(failed).resolves.toBeNull()

  void browserManager.awaitGrabSelection('page-1', 'op-1', guest)
  const retry = captureCleanBrowserPage('page-1', () => guest)
  await flush()
  expect(calls.filter((call) => call.script === TEARDOWN).length).toBeGreaterThanOrEqual(2)
  calls.splice(0).forEach((call) => call.settle(true))
  await flush()
  frames.shift()!.settle(true)
  await expect(retry).resolves.toEqual(CAPTURE)
  expect(state.captures).toBe(1)
})
