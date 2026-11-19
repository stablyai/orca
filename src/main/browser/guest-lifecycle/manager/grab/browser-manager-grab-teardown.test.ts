import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'
import { attachGrabExecutionTransport } from '../../../element-grab/testing/grab-execution-transport-fixture'

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
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(frame)
    return frames.length
  })
  const guest = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), {
      id: 7,
      isDestroyed: () => false,
      executeJavaScript: () => Promise.resolve(true)
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode and the watch only call executeJavaScript, executeJavaScriptInIsolatedWorld, on/off/once and isDestroyed, which this fixture implements.
  const page = guest as unknown as Electron.WebContents
  return { guest, page, frames }
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

    for (const frame of frames.splice(0)) {
      frame(0)
    }
    for (const frame of frames.splice(0)) {
      frame(0)
    }

    await expect(off).resolves.toBe(true)
  })
  it('rejects a teardown superseded by a new document, including its late completion', async () => {
    const manager = new BrowserManager()
    const { page, guest, frames } = heldGuest()
    const off = manager.setGrabMode('page-1', false, page)
    guest.emit('did-start-navigation', {}, 'https://example.test/new', false, true)
    await expect(off).resolves.toBe(false)
    for (const frame of frames.splice(0)) {
      frame(0)
    }
    for (const frame of frames.splice(0)) {
      frame(0)
    }
  })
})
