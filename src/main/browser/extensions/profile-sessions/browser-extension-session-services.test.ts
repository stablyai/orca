import { EventEmitter } from 'node:events'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerBrowserSessionBeforeRequest,
  setBrowserSessionRequestDecider
} from '../../sessions/requests/browser-session-request-decisions'

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
    updatePinned: vi.fn(),
    dnrBefore: vi.fn<() => Electron.CallbackResponse | Promise<Electron.CallbackResponse> | null>(
      () => null
    ),
    proxyReadiness: vi.fn<() => boolean | Promise<boolean>>(() => true)
  }
})
// Why loosely typed: the real hooks only touch `extensions` events, which the fake provides.
let attachHook: AttachHook | null = null

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => ({ session: mocks.sessionByTabId.get(id) }) }
}))
vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    updateEnabledExtensionIds: mocks.updateEnabled,
    updatePinnedExtensionIds: mocks.updatePinned,
    getEnabledExtensionIds: () => mocks.persistedEnabled,
    getPinnedExtensionIds: () => []
  }
}))
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: { setUnownedDownloadOwnerResolver: vi.fn() }
}))
vi.mock('../api/cookies', () => ({ observeBrowserExtensionCookieChanges: vi.fn() }))
vi.mock('../proxy/browser-extension-proxy-session', () => ({
  observeBrowserExtensionProxySession: vi.fn(),
  whenBrowserExtensionProxyReady: vi.fn(),
  browserExtensionProxyRequestReadiness: mocks.proxyReadiness
}))
vi.mock('../api-runtime/browser-extension-content-scripts', () => ({
  forgetBrowserExtensionContentScriptRestore: vi.fn(),
  restoreBrowserExtensionContentScripts: vi.fn()
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  getBrowserExtensionProfileIdForSession: () => 'default'
}))
vi.mock('../tabs-and-windows/browser-extension-tab-model', () => ({
  getActiveBrowserTabId: () => null
}))
vi.mock('../declarative-net-request/session/browser-extension-dnr-requests', () => ({
  browserExtensionDnrRequestDecider: { beforeRequest: mocks.dnrBefore }
}))
vi.mock('../declarative-net-request/session/browser-extension-dnr-session', () => ({
  attachBrowserExtensionDnr: vi.fn(),
  whenBrowserExtensionDnrLoaded: vi.fn()
}))
vi.mock('./browser-extension-session-loader', () => ({
  setBrowserExtensionSessionHooks: (hooks: AttachHook) => {
    attachHook = hooks
  }
}))
vi.mock('../requests/browser-extension-web-request-observer', () => ({
  installBrowserExtensionWebRequestForwarding: vi.fn(),
  observeBrowserExtensionWebRequests: vi.fn(),
  stopObservingBrowserExtensionWebRequests: vi.fn()
}))

const { installBrowserExtensionSessionServices } =
  await import('./browser-extension-session-services')
await import('../actions/browser-extension-action-registry')
const { grantBrowserExtensionActiveTab, hasBrowserExtensionActiveTab } =
  await import('../permissions/browser-extension-active-tab')

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

beforeEach(() => {
  mocks.dnrBefore.mockReset().mockReturnValue(null)
  mocks.proxyReadiness.mockReset().mockReturnValue(true)
})
afterAll(() => setBrowserSessionRequestDecider(null))

function requestDecision(): Promise<Electron.CallbackResponse> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked extension services consume this session.
  const session = attachedSession() as unknown as Electron.Session
  return new Promise((resolve) =>
    answerBrowserSessionBeforeRequest(
      session,
      {
        id: 1,
        url: 'https://example.test/',
        method: 'GET',
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 1,
        uploadData: []
      },
      resolve
    )
  )
}

describe('proxy readiness while deciding a request', () => {
  it('cancels a delayed DNR redirect when the proxy fails before completion', async () => {
    const decision = Promise.withResolvers<Electron.CallbackResponse>()
    mocks.dnrBefore.mockReturnValue(decision.promise)
    const response = requestDecision()
    mocks.proxyReadiness.mockReturnValue(false)
    decision.resolve({ redirectURL: 'https://redirect.test/' })
    await expect(response).resolves.toEqual({ cancel: true })
  })

  it('awaits asynchronous readiness again after a delayed DNR decision', async () => {
    const entered = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<Electron.CallbackResponse>()
    mocks.proxyReadiness.mockReturnValueOnce(Promise.resolve(true))
    mocks.dnrBefore.mockImplementation(() => {
      entered.resolve()
      return decision.promise
    })
    const response = requestDecision()
    await entered.promise
    mocks.proxyReadiness.mockReturnValue(Promise.resolve(false))
    decision.resolve({})
    await expect(response).resolves.toEqual({ cancel: true })
  })

  it('rechecks asynchronous readiness after a synchronous DNR decision', async () => {
    mocks.dnrBefore.mockImplementation(() => {
      mocks.proxyReadiness.mockReturnValue(Promise.resolve(false))
      return { redirectURL: 'https://redirect.test/' }
    })
    await expect(requestDecision()).resolves.toEqual({ cancel: true })
  })

  it('preserves the DNR response when readiness remains available', async () => {
    mocks.proxyReadiness.mockReturnValue(Promise.resolve(true))
    mocks.dnrBefore.mockReturnValue({ redirectURL: 'https://redirect.test/' })
    await expect(requestDecision()).resolves.toEqual({ redirectURL: 'https://redirect.test/' })
  })

  it('keeps a failed DNR decision blocked when the proxy also became unavailable', async () => {
    const decision = Promise.withResolvers<Electron.CallbackResponse>()
    mocks.dnrBefore.mockReturnValue(decision.promise)
    const response = requestDecision()
    mocks.proxyReadiness.mockReturnValue(false)
    decision.reject(new Error('DNR unavailable'))
    await expect(response).resolves.toEqual({ cancel: true })
  })
})

describe('extension unload in an attached session', () => {
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

it('refuses to acknowledge stale removal when browser metadata failed to persist', () => {
  mocks.persistedEnabled.push('removed')
  try {
    expect(() => attachHook?.uninstalled('work', new Set(['removed']))).toThrow('Could not remove')
  } finally {
    mocks.persistedEnabled.length = 0
  }
})
