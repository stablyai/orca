import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  getAuthorizedGuest: vi.fn(() => ({})),
  setAnnotationViewportBridge: vi.fn().mockResolvedValue(true)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel)
  }
}))

vi.mock('../browser/browser-manager', () => ({ browserManager: mocks }))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => true }))
vi.mock('../browser/browser-client-page-metadata-transport', () => ({
  publishBrowserClientPageMetadata: vi.fn()
}))

import { registerBrowserGuestViewHandlers } from './browser-guest-view-ipc'

beforeEach(() => {
  mocks.handlers.clear()
  mocks.getAuthorizedGuest.mockClear()
  mocks.setAnnotationViewportBridge.mockClear()
  registerBrowserGuestViewHandlers()
})

describe('browser annotation viewport IPC', () => {
  it('passes the pending selection identity through to the isolated bridge', async () => {
    const handler = mocks.handlers.get('browser:setAnnotationViewportBridge')
    expect(handler).toBeDefined()
    await handler?.(
      { sender: { id: 91 } },
      {
        browserPageId: 'page-1',
        emitViewport: true,
        enabled: true,
        markers: [],
        selectionId: '2026-10-12T19:30:00.000Z',
        token: 'annotationviewporttoken'
      }
    )

    expect(mocks.setAnnotationViewportBridge).toHaveBeenCalledWith(
      'page-1',
      {
        emitViewport: true,
        enabled: true,
        markers: [],
        selectionId: '2026-10-12T19:30:00.000Z',
        token: 'annotationviewporttoken'
      },
      expect.any(Function)
    )
  })
})
