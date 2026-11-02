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
vi.mock('./popup-origin-bar-window', () => ({ openPopupWithOriginBar: vi.fn() }))

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

it.each(['completed', 'cancelled', 'interrupted'] as const)(
  'preserves page download until native %s and then releases its routing entry',
  (state) => {
    const guest = register()
    const item = download(guest)
    guest.destroy()
    expect(item.cancel).not.toHaveBeenCalled()
    expect(manager.retainedCounts()).toMatchObject({ guests: 0, contextMenus: 0, renderers: 1 })
    getDownloadItemEventHandler(item, 'on', 'updated')?.(event, 'progressing')
    expect(renderer.send).toHaveBeenCalledWith(
      'browser:download-progress',
      expect.objectContaining({ browserPageId: 'recoverable-page' })
    )
    getDownloadItemEventHandler(item, 'once', 'done')?.(event, state)
    expect(renderer.send).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: 'recoverable-page',
        status: state === 'completed' ? 'completed' : state === 'cancelled' ? 'canceled' : 'failed'
      })
    )
    expect(manager.downloadCount()).toBe(0)
    expect(manager.retainedCounts().renderers).toBe(0)
  }
)

it('still cancels a download when its logical page closes after guest destruction', () => {
  const guest = register()
  const item = download(guest)
  guest.destroy()
  manager.unregisterGuest('recoverable-page')
  expect(item.cancel).toHaveBeenCalledOnce()
  expect(renderer.send).toHaveBeenCalledWith(
    'browser:download-finished',
    expect.objectContaining({ status: 'canceled', error: 'Tab closed before download completed.' })
  )
  expect(manager.downloadCount()).toBe(0)
  expect(manager.retainedCounts().renderers).toBe(0)
})

it('keeps progress routing until the last of multiple downloads settles', () => {
  const guest = register()
  const first = download(guest)
  const second = download(guest)
  guest.destroy()
  getDownloadItemEventHandler(first, 'once', 'done')?.(event, 'completed')
  expect(manager.downloadCount()).toBe(1)
  expect(manager.retainedCounts().renderers).toBe(1)
  getDownloadItemEventHandler(second, 'once', 'done')?.(event, 'completed')
  expect(manager.downloadCount()).toBe(0)
  expect(manager.retainedCounts().renderers).toBe(0)
})

it('keeps the replacement guest and its routing when an old download settles', () => {
  const old = register()
  const item = download(old)
  old.destroy()
  const replacement = register(5002)
  getDownloadItemEventHandler(item, 'once', 'done')?.(event, 'completed')
  expect(manager.getGuestWebContentsId('recoverable-page')).toBe(replacement.id)
  expect(manager.retainedCounts().renderers).toBe(1)
  expect(manager.downloadCount()).toBe(0)
})

it('releases current routing after two guest destructions and the final old download settles', () => {
  const old = register()
  const item = download(old)
  old.destroy()
  register(5002).destroy()
  getDownloadItemEventHandler(item, 'once', 'done')?.(event, 'completed')
  expect(manager.downloadCount()).toBe(0)
  expect(manager.retainedCounts().renderers).toBe(0)
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

it('releases download state after renderer loss without sending to a destroyed renderer', () => {
  const guest = register()
  const item = download(guest)
  guest.destroy()
  renderer.isDestroyed.mockReturnValue(true)
  renderer.send.mockClear()
  getDownloadItemEventHandler(item, 'on', 'updated')?.(event, 'progressing')
  getDownloadItemEventHandler(item, 'once', 'done')?.(event, 'completed')
  expect(renderer.send).not.toHaveBeenCalled()
  expect(manager.downloadCount()).toBe(0)
  expect(manager.retainedCounts().renderers).toBe(0)
})
