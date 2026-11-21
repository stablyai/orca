import { describe, expect, it, vi } from 'vitest'

const loadWithRetry = vi.hoisted(() => vi.fn())
const initializeFromPersistedState = vi.hoisted(() => vi.fn())

vi.mock('./site-list/browser-profile-site-list-store', () => ({
  loadBrowserProfileSiteListsWithRetry: loadWithRetry
}))
vi.mock('./profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    applyPendingCookieImport: vi.fn(),
    initializeBrowserSessionsFromPersistedState: initializeFromPersistedState
  }
}))
vi.mock('../routing/partitions/browser-route-partition-storage-runtime', () => ({}))
vi.mock('../routing/sessions/browser-route-session-runtime', () => ({}))
vi.mock('../routing/partitions/browser-route-partition-binding-runtime', () => ({}))
vi.mock('../site-settings/permissions/browser-site-permission-store', () => ({}))
vi.mock('../site-settings/display/browser-site-display-store', () => ({}))
vi.mock('../extensions/profile-storage/browser-extension-profile-data-directory', () => ({}))
vi.mock('../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime', () => ({}))
vi.mock('../../browser-passwords/browser-password-vaults', () => ({}))
vi.mock('../cookies/session-restore/browser-session-cookie-restore', () => ({}))
vi.mock('../cookies/session-restore/browser-session-cookie-snapshot-file', () => ({}))
vi.mock('./proxy/browser-session-proxy', () => ({}))
vi.mock('../webauthn/browser-passkey-requests', () => ({
  listenForBrowserPasskeyRequests: vi.fn()
}))
vi.mock('../guest-lifecycle/prompts/browser-system-dialogs', () => ({
  listenForBrowserSystemDialogs: vi.fn()
}))
vi.mock('../guest-lifecycle/visibility/browser-guest-page-visibility', () => ({
  listenForBrowserGuestPageVisibility: vi.fn()
}))

import { initializeBrowserSessionsForApp } from './browser-session-startup'

describe('initializeBrowserSessionsForApp', () => {
  it('loads site lists after the sync read, even when that read failed', () => {
    initializeBrowserSessionsForApp()
    expect(initializeFromPersistedState).toHaveBeenCalledTimes(1)
    expect(loadWithRetry).toHaveBeenCalledTimes(1)
  })
})
