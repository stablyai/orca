import { EventEmitter } from 'node:events'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import { expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  before:
    vi.fn<
      (
        listener:
          | ((
              details: Electron.OnBeforeRequestListenerDetails,
              callback: (response: Electron.CallbackResponse) => void
            ) => void)
          | null
      ) => void
    >(),
  completed: vi.fn(),
  failed: vi.fn()
}))
const browsingSession = {
  webRequest: {
    onBeforeRequest: native.before,
    onCompleted: native.completed,
    onErrorOccurred: native.failed
  },
  setUserAgent: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setDisplayMediaRequestHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}
vi.mock('electron', () => ({
  session: { fromPartition: () => browsingSession },
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))
vi.mock('../../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))
vi.mock('../../../../network/proxy-settings', () => ({
  getProxySessionApplicationReadiness: () => true,
  clearProxySessionCredentials: vi.fn()
}))
vi.mock('../../../sessions/proxy/browser-session-proxy', () => ({
  applyProxyToBrowserSession: async () => {},
  invalidateBrowserSessionProxyApplication: vi.fn()
}))
vi.mock('../../../identity/requests/browser-session-ua', () => ({
  installBrowserSessionUserAgentPolicy: () => () => {}
}))
vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ userAgent: 'test' })
}))
vi.mock('../../../webauthn/browser-webauthn-access', () => ({
  clearBrowserWebAuthnAccessHandlers: vi.fn()
}))

import {
  installBrowserSessionPartitionPolicies,
  clearBrowserSessionPartitionPolicies
} from '../../../sessions/partition-policies/browser-session-partition-policies'
import {
  installBrowserSessionRequestLifecycle,
  removeBrowserSessionRequestLifecycle
} from '../../../sessions/requests/browser-session-request-decisions'
import {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  associateBrowserPageAttach,
  reserveBrowserPageDiscard,
  closeBrowserMemoryPage
} from '../../browser-page-memory'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection
} from './browser-guest-discard-protection'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

it('certifies default-profile GET commits through the installed request policy, independent of optional completion listeners', async () => {
  const profile = {
    id: 'provenance',
    scope: 'isolated',
    partition: 'persist:provenance',
    label: 'Test',
    source: null
  } satisfies BrowserSessionProfile
  await installBrowserSessionPartitionPolicies(profile, {
    permissions: 'deny',
    applyAppWideProxy: false
  })
  const beforeRequest = native.before.mock.calls[0]?.[0]
  expect(beforeRequest).toBeTypeOf('function')
  let id = 0
  const exercise = (mode: string): void => {
    const pageId = `provenance-${++id}`
    const url = mode === 'non-http' ? 'file:///test.html' : 'https://example.test/a'
    const mainFrame = { frames: [], send: vi.fn<(channel: string, generation: string) => void>() }
    let loading = true
    let destroyed = false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native fixture implements the installed request, protection and reservation surfaces.
    const guest = Object.assign(new EventEmitter(), {
      id,
      mainFrame,
      session: browsingSession,
      hostWebContents: { id: 99 },
      getType: () => 'webview',
      isDestroyed: () => destroyed,
      isCrashed: () => false,
      isCurrentlyAudible: () => false,
      isLoading: () => loading,
      isDevToolsOpened: () => false,
      debugger: { isAttached: () => false },
      navigationHistory: {
        length: () => 1,
        getActiveIndex: () => 0,
        getAllEntries: () => [{ url, title: 'Test' }]
      },
      close: () => {
        destroyed = true
        guest.emit('destroyed')
      }
    }) as unknown as Electron.WebContents
    const marker = prepareBrowserPageAttach(pageId, 99, profile.partition, url)
    admitBrowserPageAttach(marker, 99, profile.partition)
    expect(associateBrowserPageAttach(guest)).toBe(true)
    const stop = installBrowserGuestDiscardProtection(guest, () => {})
    try {
      const start = () =>
        guest.emit('did-start-navigation', {
          url,
          frame: mainFrame,
          isMainFrame: true,
          isSameDocument: false
        })
      start()
      if (mode === 'overlap') {
        start()
      }
      const callback = vi.fn()
      if (mode !== 'missing-request') {
        beforeRequest?.(
          {
            id,
            url,
            method: mode === 'POST' ? 'POST' : 'GET',
            webContentsId: id,
            resourceType: 'mainFrame',
            timestamp: 0,
            referrer: '',
            uploadData: [],
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only identity is read from native request frames in this fixture.
            frame: (mode === 'missing-frame'
              ? null
              : mode === 'wrong-frame'
                ? {}
                : mainFrame) as Electron.WebFrameMain | null
          },
          callback
        )
        expect(callback).toHaveBeenCalledWith({})
      }
      if (mode === 'redirect') {
        guest.emit('did-redirect-navigation', { isMainFrame: true })
      }
      if (mode !== 'precommit-failure') {
        const status =
          mode === 'error'
            ? 500
            : mode === 'non-http'
              ? -1
              : mode === 'missing-status'
                ? undefined
                : 200
        guest.emit('did-navigate', {}, url, status, 'OK')
      }
      guest.emit('dom-ready')
      guest.emit(
        'ipc-message',
        { sender: guest, senderFrame: mainFrame },
        BROWSER_GUEST_PROTECTION_REPORT,
        { generation: mainFrame.send.mock.lastCall?.[1], dirty: false }
      )
      const clean = mode === 'clean'
      expect(readBrowserGuestDiscardProtection(guest).protection).toBe(
        clean ? 'discardable' : 'protected'
      )
      expect(reserveBrowserPageDiscard(pageId, guest)).toBe(false)
      loading = false
      expect(reserveBrowserPageDiscard(pageId, guest)).toBe(clean)
    } finally {
      stop()
      closeBrowserMemoryPage(pageId)
    }
  }
  try {
    exercise('clean')
    installBrowserSessionRequestLifecycle(browsingSession as unknown as Electron.Session)
    exercise('clean')
    removeBrowserSessionRequestLifecycle(browsingSession as unknown as Electron.Session)
    exercise('clean')
    for (const mode of [
      'POST',
      'missing-request',
      'missing-frame',
      'wrong-frame',
      'error',
      'non-http',
      'missing-status',
      'overlap',
      'redirect',
      'precommit-failure'
    ]) {
      exercise(mode)
    }
  } finally {
    clearBrowserSessionPartitionPolicies(
      profile.partition,
      browsingSession as unknown as Electron.Session
    )
  }
})
