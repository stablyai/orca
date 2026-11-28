import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'
import { attachGrabExecutionTransport } from '../../../element-grab/testing/grab-execution-transport-fixture'
import { GUEST_PAINT_WAIT_MS } from '../../../../../preload/browser/element-grab/browser-guest-paint'

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

afterEach(() => vi.unstubAllGlobals())

/** The private preload must wait for the painted frame before it grants a clean capture. */
function heldGuest() {
  const frames: FrameRequestCallback[] = []
  const load = { loading: false }
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(frame)
    return frames.length
  })
  const guest = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), {
      id: 7,
      isDestroyed: () => false,
      isLoadingMainFrame: () => load.loading,
      executeJavaScript: () => Promise.resolve(true)
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode and the watch only call executeJavaScript, executeJavaScriptInIsolatedWorld, on/off/once, isLoadingMainFrame and isDestroyed, which this fixture implements.
  const page = guest as unknown as Electron.WebContents
  // The same document finishes loading: no navigation, so the request's scope stays current.
  const stopLoading = (): void => {
    load.loading = false
    guest.emit('did-stop-loading')
  }
  return { guest, page, frames, load, stopLoading }
}

const paintTwoFrames = (frames: FrameRequestCallback[]): void => {
  for (const frame of frames.splice(0)) {
    frame(0)
  }
  for (const frame of frames.splice(0)) {
    frame(0)
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('turning the picker off before Draw captures', () => {
  it('grants clean capture only after the private painted-frame wait', async () => {
    const manager = new BrowserManager()
    const { page, frames } = heldGuest()
    let settled = false
    const off = manager.setGrabMode('page-1', false, page).then((ok) => {
      settled = true
      return ok
    })
    await flush()
    expect(settled).toBe(false)

    paintTwoFrames(frames)

    await expect(off).resolves.toBe(true)
  })
  it('rejects a teardown superseded by a new document, including its late completion', async () => {
    const manager = new BrowserManager()
    const { page, guest, frames } = heldGuest()
    const off = manager.setGrabMode('page-1', false, page)
    guest.emit('did-start-navigation', {}, 'https://example.test/new', false, true)
    await expect(off).resolves.toBe(false)
    paintTwoFrames(frames)
  })

  // Draw waits on this very request and does not retry, so it must resume once the load stops.
  it('a teardown that began during loading waits for the load to stop, then succeeds', async () => {
    const manager = new BrowserManager()
    const { page, frames, load, stopLoading } = heldGuest()
    load.loading = true
    let settled = false
    const original = manager.setGrabMode('page-1', false, page).then((ok) => {
      settled = true
      return ok
    })
    await flush()
    // Still loading: the request is parked, not refused, and has not reached the page yet.
    expect({ settled, framesRequested: frames.length }).toEqual({
      settled: false,
      framesRequested: 0
    })

    stopLoading()
    await flush()
    paintTwoFrames(frames)
    // Fresh work after the load is shown too, so a refusal of only the original stands out.
    const fresh = manager.setGrabMode('page-1', false, page)
    await flush()
    paintTwoFrames(frames)
    expect({ original: await original, fresh: await fresh }).toEqual({
      original: true,
      fresh: true
    })
  })

  it('refuses a teardown that began during loading when no frame comes within the paint wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const manager = new BrowserManager()
      const { page, frames, load, stopLoading } = heldGuest()
      load.loading = true
      const original = manager.setGrabMode('page-1', false, page)
      await flush()
      stopLoading()
      await flush()
      // The page asked for a frame but none is produced.
      expect(frames.length).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(GUEST_PAINT_WAIT_MS)
      await expect(original).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
