import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  authorized: vi.fn(),
  trusted: vi.fn(() => true),
  guestId: vi.fn(() => 12),
  defaultSession: {},
  browserSession: { clearStorageData: vi.fn(), clearCache: vi.fn() }
}))
vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: mocks.handle },
  session: {
    defaultSession: mocks.defaultSession,
    fromPartition: (partition: string) =>
      partition === 'persist:isolated-browser' ? mocks.browserSession : mocks.defaultSession
  }
}))
vi.mock('../browser/browser-manager', () => ({
  browserManager: { getAuthorizedGuest: mocks.authorized, getGuestWebContentsId: mocks.guestId }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: mocks.trusted }))
import { registerBrowserBrowsingDataHandlers } from './browser-browsing-data-ipc'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.trusted.mockReturnValue(true)
  mocks.guestId.mockReturnValue(12)
  mocks.authorized.mockReturnValue({
    id: 12,
    isDestroyed: () => false,
    session: mocks.browserSession
  })
  registerBrowserBrowsingDataHandlers()
})
function clear(cookies: unknown, cache: unknown, partition = 'persist:isolated-browser') {
  return mocks.handle.mock.calls[0][1](
    { sender: { id: 5 } },
    { browserPageId: 'page', partition, cookies, cache }
  )
}
it('clears only selected data on the authorized guest session', async () => {
  expect(await clear(false, true)).toBe('persist:isolated-browser')
  expect(mocks.browserSession.clearCache).toHaveBeenCalledOnce()
  expect(mocks.browserSession.clearStorageData).not.toHaveBeenCalled()
})
it('uses an explicit site storage list and leaves cache alone', async () => {
  await clear(true, false)
  expect(mocks.browserSession.clearStorageData).toHaveBeenCalledWith({
    storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'filesystem']
  })
  expect(mocks.browserSession.clearCache).not.toHaveBeenCalled()
})
it('resolves history scope without clearing storage', async () => {
  expect(await clear(false, false)).toBe('persist:isolated-browser')
  expect(mocks.browserSession.clearCache).not.toHaveBeenCalled()
  expect(mocks.browserSession.clearStorageData).not.toHaveBeenCalled()
})
it('refuses untrusted callers, malformed choices, missing pages and document guests', async () => {
  mocks.trusted.mockReturnValue(false)
  await expect(clear(true, true)).rejects.toThrow()
  mocks.trusted.mockReturnValue(true)
  await expect(clear('true', false)).rejects.toThrow()
  mocks.authorized.mockReturnValue(null)
  await expect(clear(true, true)).rejects.toThrow()
  mocks.authorized.mockReturnValue({ id: 99, isDestroyed: () => false })
  await expect(clear(true, true)).rejects.toThrow()
  expect(mocks.browserSession.clearStorageData).not.toHaveBeenCalled()
})
it('refuses app storage and propagates failures without claiming success', async () => {
  mocks.authorized.mockReturnValue({
    id: 12,
    isDestroyed: () => false,
    session: mocks.defaultSession
  })
  await expect(clear(true, true)).rejects.toThrow()
  expect(mocks.browserSession.clearStorageData).not.toHaveBeenCalled()
})
it('propagates storage errors and does not clear the next category', async () => {
  mocks.browserSession.clearStorageData.mockRejectedValueOnce(new Error('failed'))
  await expect(clear(true, true)).rejects.toThrow('failed')
  expect(mocks.browserSession.clearCache).not.toHaveBeenCalled()
})

it('refuses a partition that does not belong to the authorized guest', async () => {
  await expect(clear(true, true, 'persist:unrelated')).rejects.toThrow('partition is unavailable')
  expect(mocks.browserSession.clearStorageData).not.toHaveBeenCalled()
  expect(mocks.browserSession.clearCache).not.toHaveBeenCalled()
})
