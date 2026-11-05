import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ contents: new Map<number, unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: (id: number) => mocks.contents.get(id) ?? null }
}))
vi.mock('../popups/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))

import {
  DestroyedGuestTestContents,
  DestroyedGuestTestManager
} from './browser-manager-destroyed-guest-test-fixture'
import { createDownloadItem, getDownloadItemEventHandler } from './browser-manager-test-harness'

const event = { preventDefault: () => {}, defaultPrevented: false }
const manager = new DestroyedGuestTestManager()
const renderer = { isDestroyed: vi.fn(() => false), send: vi.fn() }
let nextGuestId = 1

function register(rendererId = 5001): DestroyedGuestTestContents {
  const guest = new DestroyedGuestTestContents(nextGuestId++)
  mocks.contents.set(guest.id, guest.asWebContents())
  mocks.contents.set(rendererId, renderer)
  manager.attachGuestPolicies(guest.asWebContents())
  expect(
    manager.registerGuest({
      browserPageId: 'recoverable-page',
      webContentsId: guest.id,
      rendererWebContentsId: rendererId
    })
  ).toBe(true)
  return guest
}

function download(guest: DestroyedGuestTestContents): Electron.DownloadItem {
  const item = createDownloadItem()
  manager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })
  return item
}

beforeEach(() => {
  renderer.isDestroyed.mockReset().mockReturnValue(false)
  renderer.send.mockClear()
})
afterEach(() => {
  manager.unregisterAll()
  mocks.contents.clear()
})

it('does not erase a replacement routing owner installed during completion delivery', () => {
  const old = register()
  const item = download(old)
  old.destroy()
  renderer.send.mockImplementationOnce(() => register(5002))
  getDownloadItemEventHandler(item, 'once', 'done')?.(event, 'completed')
  expect(manager.retainedCounts().renderers).toBe(1)
  manager.unregisterGuest('recoverable-page')
  expect(manager.retainedCounts().renderers).toBe(0)
})
