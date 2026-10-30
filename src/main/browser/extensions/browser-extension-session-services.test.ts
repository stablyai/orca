import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

type FakeSession = { extensions: EventEmitter }
type AttachHook = {
  attached: (sess: FakeSession, profileId: string, ids: string[]) => void
  uninstalled: (profileId: string, extensionIds: ReadonlySet<string>) => void
}

const mocks = vi.hoisted(() => {
  const persistedEnabled: string[] = []
  return {
    persistedEnabled,
    sessionByTabId: new Map<number, unknown>(),
    updateEnabled: vi.fn(),
    updatePinned: vi.fn()
  }
})
// Why loosely typed: the real hooks only touch `extensions` events, which the fake provides.
let attachHook: AttachHook | null = null

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => ({ session: mocks.sessionByTabId.get(id) }) }
}))
vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    updateEnabledExtensionIds: mocks.updateEnabled,
    updatePinnedExtensionIds: mocks.updatePinned,
    getEnabledExtensionIds: () => mocks.persistedEnabled,
    getPinnedExtensionIds: () => []
  }
}))
vi.mock('../browser-manager', () => ({
  browserManager: { setUnownedDownloadOwnerResolver: vi.fn() }
}))
vi.mock('./api/cookies', () => ({ observeBrowserExtensionCookieChanges: vi.fn() }))
vi.mock('./api/scripting', () => ({
  forgetBrowserExtensionContentScriptRestore: vi.fn(),
  restoreBrowserExtensionContentScripts: vi.fn()
}))
vi.mock('./browser-extension-api-host', () => ({
  getBrowserExtensionProfileIdForSession: () => 'default'
}))
vi.mock('./browser-extension-tab-model', () => ({ getActiveBrowserTabId: () => null }))
vi.mock('../browser-session-request-decisions', () => ({
  setBrowserSessionRequestDecider: vi.fn()
}))
vi.mock('./browser-extension-dnr-requests', () => ({ browserExtensionDnrRequestDecider: vi.fn() }))
vi.mock('./browser-extension-dnr-session', () => ({
  attachBrowserExtensionDnr: vi.fn(),
  whenBrowserExtensionDnrLoaded: vi.fn()
}))
vi.mock('./browser-extension-session-loader', () => ({
  setBrowserExtensionSessionHooks: (hooks: AttachHook) => {
    attachHook = hooks
  }
}))
vi.mock('./browser-extension-web-request', () => ({
  installBrowserExtensionWebRequestForwarding: vi.fn(),
  observeBrowserExtensionWebRequests: vi.fn(),
  stopObservingBrowserExtensionWebRequests: vi.fn()
}))

const { installBrowserExtensionSessionServices } =
  await import('./browser-extension-session-services')
const { getBrowserExtensionActionState } = await import('./browser-extension-action-registry')
const { grantBrowserExtensionActiveTab, hasBrowserExtensionActiveTab } =
  await import('./browser-extension-active-tab')

function attachedSession(): FakeSession {
  const sess = { extensions: new EventEmitter() }
  attachHook?.attached(sess, 'default', [])
  return sess
}

function extension(id: string): Electron.Extension {
  return {
    id,
    name: 'Vault',
    path: `/extensions/${id}`,
    url: `chrome-extension://${id}/`,
    version: '1.0',
    manifest: { permissions: ['activeTab'], action: { default_title: 'Vault' } }
  }
}

installBrowserExtensionSessionServices()

describe('extension unload in an attached session', () => {
  it('drops action state set before any toolbar asked for it', () => {
    const sess = attachedSession()
    const vault = extension('vault')
    getBrowserExtensionActionState('default', vault).set('badgeText', 'OLD', null)
    sess.extensions.emit('extension-unloaded', {}, vault)
    expect(getBrowserExtensionActionState('default', vault).get(null).badgeText).toBe('')
  })

  it("revokes the extension's activeTab grants on that session's tabs only", () => {
    const sess = attachedSession()
    const other = attachedSession()
    mocks.sessionByTabId.set(1, sess)
    mocks.sessionByTabId.set(2, other)
    const vault = extension('vault')
    grantBrowserExtensionActiveTab(vault, 1)
    grantBrowserExtensionActiveTab(vault, 2)
    sess.extensions.emit('extension-unloaded', {}, vault)
    expect(hasBrowserExtensionActiveTab('vault', 1)).toBe(false)
    expect(hasBrowserExtensionActiveTab('vault', 2)).toBe(true)
  })
})

it('removes stale enabled and pinned ids only in the affected browser profile', () => {
  attachHook?.uninstalled('work', new Set(['removed']))
  const before = { work: ['removed', 'kept'], home: ['removed'] }
  expect(mocks.updateEnabled.mock.calls.at(-1)?.[0](before)).toEqual({
    work: ['kept'],
    home: ['removed']
  })
  expect(mocks.updatePinned.mock.calls.at(-1)?.[0](before)).toEqual({
    work: ['kept'],
    home: ['removed']
  })
})

it('refuses to acknowledge stale removal when browser metadata failed to persist', () => {
  mocks.persistedEnabled.push('removed')
  try {
    expect(() => attachHook?.uninstalled('work', new Set(['removed']))).toThrow('Could not remove')
  } finally {
    mocks.persistedEnabled.length = 0
  }
})
