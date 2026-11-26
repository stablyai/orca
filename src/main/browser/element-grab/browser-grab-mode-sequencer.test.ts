import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import { resetGrabModeState, setBrowserGrabMode } from './browser-grab-mode-sequencer'
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
  const state = { loading }
  const emitter = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    isLoadingMainFrame: () => state.loading,
    executeJavaScript: (script: string) => new Promise((settle) => calls.push({ script, settle }))
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grab mode only calls executeJavaScript, isLoadingMainFrame, isDestroyed and on/off/once, which this fake implements.
  const guest = emitter as unknown as Electron.WebContents
  const stopLoading = (): void => {
    state.loading = false
    emitter.emit('did-stop-loading')
  }
  return { guest, calls, stopLoading }
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
