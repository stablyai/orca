import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  isTrusted: vi.fn((_sender: unknown) => true),
  publish: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  }
}))

vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))

vi.mock('./browser-renderer-trust', () => ({
  isTrustedBrowserRenderer: (sender: unknown) => mocks.isTrusted(sender)
}))

vi.mock('../browser/browser-client-page-metadata-transport', () => ({
  publishBrowserClientPageMetadata: (environmentId: string, params: unknown) =>
    mocks.publish(environmentId, params)
}))

import { registerBrowserGuestViewHandlers } from './browser-guest-view-ipc'

const PARAMS = {
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  browserPageId: 'page-a',
  pageHostGeneration: 7,
  revision: 2,
  url: 'https://example.internal/moved',
  title: 'Moved',
  loading: false,
  canGoBack: true,
  canGoForward: false
}

function publishMetadata(args: unknown): Promise<unknown> {
  const handler = mocks.handlers.get('browser:publishClientPageMetadata')
  if (!handler) {
    throw new Error('browser:publishClientPageMetadata was never registered')
  }
  return Promise.resolve(handler({ sender: { id: 1 } }, args))
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.isTrusted.mockReset().mockReturnValue(true)
  mocks.publish.mockReset().mockResolvedValue({ accepted: true })
  registerBrowserGuestViewHandlers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('browser:publishClientPageMetadata', () => {
  // Untrusted renderer identities must not reach the paired runtime lease.
  it('refuses an untrusted renderer before touching the lease', async () => {
    mocks.isTrusted.mockReturnValue(false)

    await expect(
      publishMetadata({ environmentId: 'environment-a', params: PARAMS })
    ).resolves.toEqual({ status: 'refused' })
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it.each([
    ['no environment', { environmentId: '', params: PARAMS }],
    ['a non-string environment', { environmentId: 7, params: PARAMS }],
    ['no params at all', { environmentId: 'environment-a' }],
    [
      'a revision below the protocol floor',
      {
        environmentId: 'environment-a',
        params: { ...PARAMS, revision: 0 }
      }
    ],
    [
      'a page id the protocol rejects',
      {
        environmentId: 'environment-a',
        params: { ...PARAMS, browserPageId: '' }
      }
    ]
  ])('refuses %s without reaching the lease', async (_case, args) => {
    await expect(publishMetadata(args)).resolves.toEqual({ status: 'refused' })
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
