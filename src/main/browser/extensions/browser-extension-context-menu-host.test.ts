import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredContextMenuItem } from './browser-extension-profile-state-store'

const mocks = vi.hoisted(() => ({
  items: Array<StoredContextMenuItem>(),
  emit: vi.fn()
}))
const VAULT = 'a'.repeat(32)

vi.mock('./api/web-navigation', () => ({ chromeFrameId: () => 0 }))
vi.mock('./api/permissions', () => ({ noteBrowserExtensionUserGesture: vi.fn() }))
vi.mock('./browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: mocks.emit,
  getBrowserExtensionProfileIdForSession: () => 'default'
}))
vi.mock('./browser-extension-active-tab', () => ({ grantBrowserExtensionActiveTab: vi.fn() }))
vi.mock('./browser-extension-document-ids', () => ({ getBrowserExtensionDocumentId: () => null }))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ get: () => null })
}))
vi.mock('./browser-extension-namespace-registry', () => ({ extensionHasPermission: () => true }))
vi.mock('./browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({ read: () => ({ contextMenus: mocks.items }) })
}))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: () => ({
    extensions: { getExtension: (id: string) => ({ id, name: 'Vault' }) }
  })
}))
vi.mock('./browser-extension-tab-model', () => ({
  resolveBrowserExtensionTab: () => null,
  describeBrowserExtensionTab: vi.fn()
}))

import { createContextMenuItem } from './browser-extension-context-menu-model'
import * as menuHost from './browser-extension-context-menu-host'

beforeEach(() => mocks.emit.mockClear())

describe('context-menu snapshot expiry', () => {
  it('expires abandoned menu tokens without another menu being opened', async () => {
    mocks.items = createContextMenuItem([], { id: 'expired', title: 'Expired', contexts: ['all'] })
    vi.useFakeTimers()
    try {
      const tokens = Array.from(
        { length: 100 },
        () => menuHost.buildBrowserExtensionActionContextMenu('default', VAULT, null)?.token ?? ''
      )
      const pendingTimers = vi.getTimerCount()
      await vi.advanceTimersByTimeAsync(600_001)
      const results = tokens.map((token) =>
        menuHost.runBrowserExtensionContextMenuClick({
          token,
          extensionId: VAULT,
          key: '"expired"'
        })
      )

      expect(results).toEqual(Array(100).fill(false))
      expect(mocks.emit.mock.calls).toEqual([])
      expect(pendingTimers).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a later menu usable when an older menu expires and clears its last timer', async () => {
    mocks.items = createContextMenuItem([], { id: 'fresh', title: 'Fresh', contexts: ['all'] })
    vi.useFakeTimers()
    try {
      const oldToken =
        menuHost.buildBrowserExtensionActionContextMenu('default', VAULT, null)?.token ?? ''
      await vi.advanceTimersByTimeAsync(300_001)
      const freshToken =
        menuHost.buildBrowserExtensionActionContextMenu('default', VAULT, null)?.token ?? ''
      await vi.advanceTimersByTimeAsync(300_000)
      const oldResult = menuHost.runBrowserExtensionContextMenuClick({
        token: oldToken,
        extensionId: VAULT,
        key: '"fresh"'
      })
      const freshResult = menuHost.runBrowserExtensionContextMenuClick({
        token: freshToken,
        extensionId: VAULT,
        key: '"fresh"'
      })

      expect(oldResult).toBe(false)
      expect(freshResult).toBe(true)
      expect(
        menuHost.runBrowserExtensionContextMenuClick({
          token: freshToken,
          extensionId: VAULT,
          key: '"fresh"'
        })
      ).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses an expired token when the wall clock advances before its timer runs', async () => {
    mocks.items = createContextMenuItem([], { id: 'jump', title: 'Jump', contexts: ['all'] })
    vi.useFakeTimers()
    try {
      const token =
        menuHost.buildBrowserExtensionActionContextMenu('default', VAULT, null)?.token ?? ''
      vi.setSystemTime(Date.now() + 600_001)

      expect(
        menuHost.runBrowserExtensionContextMenuClick({ token, extensionId: VAULT, key: '"jump"' })
      ).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
