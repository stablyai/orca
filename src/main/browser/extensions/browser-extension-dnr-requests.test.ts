import { mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservedWebRequestDetails } from '../browser-session-web-request-observer'
import { setBrowserSessionRequestDecider } from '../browser-session-request-decisions'

const mocks = vi.hoisted(() => ({
  userData: '',
  tabs: new Set<number>(),
  installed: new Map<string, { permissions: string[] }>(),
  profileLoaded: Promise.resolve()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => mocks.userData },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() },
  webFrameMain: { fromId: vi.fn() }
}))
vi.mock('./browser-extension-install-store', () => ({
  getBrowserExtensionInstallStore: () => ({ get: (id: string) => mocks.installed.get(id) ?? null })
}))
vi.mock('./browser-extension-session-loader', () => ({
  whenBrowserExtensionProfileLoaded: () => mocks.profileLoaded
}))
vi.mock('./browser-extension-tab-model', () => ({
  resolveBrowserExtensionTab: (id: number) => (mocks.tabs.has(id) ? { contents: { id } } : null)
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-dnr-requests-'))

const { browserExtensionDnrRequestDecider: decider } =
  await import('./browser-extension-dnr-requests')
const { attachBrowserExtensionDnr, getDnrSessionRuntime } =
  await import('./browser-extension-dnr-session')
const { observeBrowserExtensionDnrContents } = await import('./browser-extension-dnr-contents')
const { getBrowserExtensionActionState } = await import('./browser-extension-action-registry')
const { stopObservingBrowserExtensionWebRequests } = await import('./browser-extension-web-request')

const BLOCKER = 'c'.repeat(32)
const PAGE = 'https://site.example'
const TAB = 5

type Rule = { id: number; priority?: number; condition: object; action: object }

function blocker(rules: Rule[], manifest: Record<string, unknown> = {}): Electron.Extension {
  const path = mkdtempSync(join(tmpdir(), 'orca-dnr-extension-'))
  writeFileSync(join(path, 'rules.json'), JSON.stringify(rules))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DNR code reads only id, version, path and manifest.
  return {
    id: BLOCKER,
    name: 'Blocker',
    version: '1',
    path,
    url: `chrome-extension://${BLOCKER}/`,
    manifest: {
      permissions: ['declarativeNetRequest'],
      host_permissions: ['<all_urls>'],
      declarative_net_request: {
        rule_resources: [{ id: 'main', enabled: true, path: 'rules.json' }]
      },
      ...manifest
    }
  } as unknown as Electron.Extension
}

function sessionWith(extension: Electron.Extension, loaded: Electron.Extension[] = [extension]) {
  const finished = new Map<string, (details: ObservedWebRequestDetails) => void>()
  const registerFinished = (event: string) =>
    vi.fn((_filter: unknown, listener: (details: ObservedWebRequestDetails) => void) => {
      finished.set(event, listener)
    })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime touches only these session members.
  const session = {
    extensions: { on: vi.fn(), getAllExtensions: () => loaded },
    webRequest: {
      onHeadersReceived: vi.fn(),
      onCompleted: registerFinished('onCompleted'),
      onErrorOccurred: registerFinished('onErrorOccurred')
    }
  } as unknown as Electron.Session
  attachBrowserExtensionDnr(session, `profile-${Math.random()}`, [extension.id])
  const runtime = getDnrSessionRuntime(session)
  if (!runtime) {
    throw new Error('runtime missing')
  }
  return {
    session,
    runtime,
    finish: (event: string, request: ObservedWebRequestDetails) => {
      const listener = finished.get(event)
      if (!listener) {
        throw new Error(`Missing ${event} listener`)
      }
      listener(request)
    }
  }
}

async function loadedSession(extension: Electron.Extension) {
  const { session, runtime, finish } = sessionWith(extension)
  await runtime.whenLoaded()
  return { session, runtime, finish }
}

let nextId = 1
function details(
  url: string,
  overrides: Partial<Omit<Electron.OnBeforeRequestListenerDetails, 'uploadData'>> = {}
): Electron.OnBeforeRequestListenerDetails {
  return {
    id: nextId++,
    url,
    method: 'GET',
    resourceType: 'script',
    referrer: '',
    timestamp: 0,
    webContentsId: TAB,
    initiatorOrigin: PAGE,
    uploadData: [],
    ...overrides
  }
}

function headersReceived(
  request: Electron.OnBeforeRequestListenerDetails,
  responseHeaders: Record<string, string[]>
): Electron.OnHeadersReceivedListenerDetails {
  return { ...request, statusLine: 'HTTP/1.1 200 OK', statusCode: 200, responseHeaders }
}

mocks.tabs.add(TAB)
afterEach(() => setBrowserSessionRequestDecider(null))

describe('declarativeNetRequest in Orca request handlers', () => {
  it('does no work in a session whose extensions have no rules', async () => {
    const { session, runtime } = await loadedSession(blocker([]))
    expect(runtime.inUse).toBe(false)
    expect(decider.beforeRequest(session, details('https://ads.example/a.js'))).toBeNull()
  })

  it('blocks, redirects, upgrades and allows page requests', async () => {
    const { session } = await loadedSession(
      blocker([
        { id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } },
        {
          id: 2,
          priority: 2,
          condition: { urlFilter: '||ads.example/ok' },
          action: { type: 'allow' }
        },
        {
          id: 3,
          condition: { urlFilter: '||tracker.example^' },
          action: { type: 'redirect', redirect: { extensionPath: '/noop.js' } }
        },
        {
          id: 4,
          condition: { urlFilter: '|http://old.example' },
          action: { type: 'upgradeScheme' }
        }
      ])
    )
    expect(decider.beforeRequest(session, details('https://ads.example/a.js'))).toEqual({
      cancel: true
    })
    expect(decider.beforeRequest(session, details('https://ads.example/ok.js'))).toBeNull()
    expect(decider.beforeRequest(session, details('https://tracker.example/t.js'))).toEqual({
      redirectURL: `chrome-extension://${BLOCKER}/noop.js`
    })
    expect(decider.beforeRequest(session, details('http://old.example/x'))).toEqual({
      redirectURL: 'https://old.example/x'
    })
  })

  it("leaves Orca's own requests, the Web Store and extension URLs alone", async () => {
    const { session } = await loadedSession(
      blocker([{ id: 1, condition: { urlFilter: '*' }, action: { type: 'block' } }])
    )
    const own = details('https://ads.example/a.js', {
      webContentsId: undefined,
      initiatorOrigin: undefined
    })
    expect(decider.beforeRequest(session, own)).toBeNull()
    expect(
      decider.beforeRequest(session, details('https://chromewebstore.google.com/detail/x'))
    ).toBeNull()
    expect(decider.beforeRequest(session, details(`chrome-extension://${BLOCKER}/a.js`))).toBeNull()
    // A page's service worker has no webContents but names its initiator: still filtered.
    const worker = details('https://x.example/a.js', { webContentsId: undefined })
    expect(decider.beforeRequest(session, worker)).toEqual({ cancel: true })
  })

  it('redirects only with host access to the request', async () => {
    const { session } = await loadedSession(
      blocker(
        [
          {
            id: 1,
            condition: { urlFilter: '||tracker.example^' },
            action: { type: 'redirect', redirect: { url: 'https://safe.example/' } }
          },
          { id: 2, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } }
        ],
        { host_permissions: ['https://other.example/*'] }
      )
    )
    expect(decider.beforeRequest(session, details('https://tracker.example/t.js'))).toBeNull()
    expect(decider.beforeRequest(session, details('https://ads.example/a.js'))).toEqual({
      cancel: true
    })
  })

  it('holds requests until the rules have loaded', async () => {
    const { session } = sessionWith(
      blocker([{ id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } }])
    )
    const held = decider.beforeRequest(session, details('https://ads.example/a.js'))
    expect(held).toBeInstanceOf(Promise)
    await expect(held).resolves.toEqual({ cancel: true })
  })

  it('holds requests at startup until enabled blockers have loaded', async () => {
    const extension = blocker([
      { id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } }
    ])
    mocks.installed.set(BLOCKER, { permissions: ['declarativeNetRequest'] })
    let finishStartup = (): void => {}
    mocks.profileLoaded = new Promise((resolve) => (finishStartup = resolve))
    const { session, runtime } = sessionWith(extension, [])
    const held = decider.beforeRequest(session, details('https://ads.example/a.js'))
    expect(held).toBeInstanceOf(Promise)
    // The extension loads during startup; the held request then gets its rules.
    void runtime.addExtension(extension)
    finishStartup()
    await expect(held).resolves.toEqual({ cancel: true })
    mocks.installed.clear()
    mocks.profileLoaded = Promise.resolve()
  })

  it('modifies request headers, then response headers once they arrive', async () => {
    const { session } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: { urlFilter: '||site.example^' },
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-blocker', operation: 'set', value: 'on' }],
            responseHeaders: [{ header: 'x-frame-options', operation: 'remove' }]
          }
        }
      ])
    )
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledOnce()
    const request = details('https://site.example/page', { resourceType: 'subFrame' })
    expect(decider.beforeRequest(session, request)).toBeNull()
    const headers = { 'User-Agent': 'Orca', Accept: '*/*' }
    expect(
      decider.beforeSendHeaders(session, { ...request, requestHeaders: headers }, headers)
    ).toEqual({ 'User-Agent': 'Orca', Accept: '*/*', 'x-blocker': 'on' })
    expect(
      decider.headersReceived(
        session,
        headersReceived(request, { 'X-Frame-Options': ['DENY'], 'Content-Type': ['text/html'] })
      )
    ).toEqual({ responseHeaders: { 'Content-Type': ['text/html'] } })
  })

  it.each(['authority', 'host access'])(
    'drops pending header mutations after losing %s',
    async (lost) => {
      const extension = blocker([
        {
          id: 1,
          condition: {},
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-retired', operation: 'set', value: 'on' }],
            responseHeaders: [{ header: 'x-retired', operation: 'set', value: 'on' }]
          }
        }
      ])
      if (lost === 'host access') {
        extension.manifest.host_permissions = []
      }
      const { session, runtime } = await loadedSession(extension)
      const { getBrowserExtensionProfileStateStore } =
        await import('./browser-extension-profile-state-store')
      const store = getBrowserExtensionProfileStateStore()
      if (lost === 'host access') {
        store.update(runtime.profileId, extension.id, (state) => ({
          ...state,
          grantedOrigins: ['<all_urls>']
        }))
      }
      const other = blocker([
        {
          id: 2,
          condition: {},
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-active', operation: 'set', value: 'on' }]
          }
        }
      ])
      other.id = 'b'.repeat(32)
      await runtime.addExtension(other)
      const request = details('https://site.example/page')
      expect(decider.beforeRequest(session, request)).toBeNull()
      if (lost === 'authority') {
        extension.manifest.permissions = []
      } else {
        store.update(runtime.profileId, extension.id, (state) => ({ ...state, grantedOrigins: [] }))
      }
      await runtime.reconcilePermissions(extension)
      const headers = { Accept: '*/*' }
      expect(
        decider.beforeSendHeaders(session, { ...request, requestHeaders: headers }, headers)
      ).toEqual(headers)
      expect(decider.headersReceived(session, headersReceived(request, {}))).toEqual({
        responseHeaders: { 'x-active': ['on'] }
      })
    }
  )

  it('blocks on response header conditions at onHeadersReceived', async () => {
    const { session } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: {
            urlFilter: '||cdn.example^',
            responseHeaders: [{ header: 'content-type', values: ['application/x-evil'] }]
          },
          action: { type: 'block' }
        }
      ])
    )
    const request = details('https://cdn.example/file')
    expect(decider.beforeRequest(session, request)).toBeNull()
    expect(
      decider.headersReceived(
        session,
        headersReceived(request, { 'Content-Type': ['application/x-evil'] })
      )
    ).toEqual({ cancel: true })
    const harmless = details('https://cdn.example/other')
    expect(
      decider.headersReceived(session, headersReceived(harmless, { 'Content-Type': ['text/css'] }))
    ).toBeNull()
  })

  it('matches long response header values without losing a blocking decision', async () => {
    const { session } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: { responseHeaders: [{ header: 'x-long', values: ['*needle*'] }] },
          action: { type: 'block' }
        }
      ])
    )
    const request = details('https://cdn.example/file')
    expect(
      decider.headersReceived(
        session,
        headersReceived(request, { 'X-Long': [`${'a'.repeat(20_000)}needle`] })
      )
    ).toEqual({ cancel: true })
  })

  it('preserves response actions for every concurrent request', async () => {
    const { session } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: {},
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-protection', operation: 'set', value: 'on' }]
          }
        }
      ])
    )
    const requests = Array.from({ length: 2_001 }, () => details('https://cdn.example/file'))
    for (const request of requests) {
      decider.beforeRequest(session, request)
    }
    for (const request of requests) {
      expect(decider.headersReceived(session, headersReceived(request, {}))).toEqual({
        responseHeaders: { 'x-protection': ['on'] }
      })
    }
  })

  it.each(['onCompleted', 'onErrorOccurred'])(
    'releases DNR-only request state after %s',
    async (event) => {
      const { session, runtime, finish } = await loadedSession(
        blocker([
          {
            id: 1,
            condition: {},
            action: {
              type: 'modifyHeaders',
              responseHeaders: [{ header: 'x-protection', operation: 'set', value: 'on' }]
            }
          }
        ])
      )
      setBrowserSessionRequestDecider(decider)
      const request = details('https://cdn.example/file')
      decider.beforeRequest(session, request)
      expect(runtime.requestState(request.id)).toBeDefined()
      finish(event, request)
      expect(runtime.requestState(request.id)).toBeUndefined()
    }
  )

  it('settles only the failed navigation when another navigation is pending', async () => {
    const { session, runtime, finish } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: { resourceTypes: ['main_frame'] },
          action: { type: 'redirect', redirect: { url: 'https://safe.example/' } }
        }
      ])
    )
    setBrowserSessionRequestDecider(decider)
    const failed = details('https://first.example/', { resourceType: 'mainFrame' })
    const pending = details('https://second.example/', { resourceType: 'mainFrame' })
    decider.beforeRequest(session, failed)
    decider.beforeRequest(session, pending)
    finish('onErrorOccurred', failed)
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(1)
    runtime.matched.commitNavigation(TAB)
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(1)
  })

  it('keeps successful navigation matches when completion arrives before commit', async () => {
    const { session, runtime, finish } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: { resourceTypes: ['main_frame'] },
          action: { type: 'redirect', redirect: { url: 'https://safe.example/' } }
        }
      ])
    )
    setBrowserSessionRequestDecider(decider)
    const request = details('https://site.example/', { resourceType: 'mainFrame' })
    decider.beforeRequest(session, request)
    finish('onCompleted', request)
    runtime.matched.commitNavigation(TAB)
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(1)
  })

  it('settles a completed navigation that stops loading without committing a document', async () => {
    const { session, runtime, finish } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: { resourceTypes: ['main_frame'] },
          action: { type: 'redirect', redirect: { url: 'https://download.example/' } }
        }
      ])
    )
    setBrowserSessionRequestDecider(decider)
    const contents = Object.assign(new EventEmitter(), { id: TAB, session })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads id/session and subscribes only to native events.
    observeBrowserExtensionDnrContents(contents as unknown as Electron.WebContents)
    const request = details('https://download.example/file', { resourceType: 'mainFrame' })
    decider.beforeRequest(session, request)
    finish('onCompleted', request)
    contents.emit('did-stop-loading')
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(1)

    contents.emit('did-navigate')
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(0)
    contents.emit('did-stop-loading')
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(0)
  })

  it('releases pending enforcement when extension request handling stops', async () => {
    const { session, runtime } = await loadedSession(
      blocker([
        {
          id: 1,
          condition: {},
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'x-protection', operation: 'set', value: 'on' }]
          }
        }
      ])
    )
    setBrowserSessionRequestDecider(decider)
    const request = details('https://cdn.example/file')
    decider.beforeRequest(session, request)
    expect(runtime.requestState(request.id)).toBeDefined()
    stopObservingBrowserExtensionWebRequests(session)
    expect(runtime.requestState(request.id)).toBeUndefined()
  })

  it('counts blocked main-frame matches immediately and does not carry them to the next document', async () => {
    const { session, runtime } = await loadedSession(
      blocker([{ id: 1, condition: { resourceTypes: ['main_frame'] }, action: { type: 'block' } }])
    )
    expect(
      decider.beforeRequest(
        session,
        details('https://blocked.example/', { resourceType: 'mainFrame' })
      )
    ).toEqual({ cancel: true })
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(1)
    runtime.matched.commitNavigation(TAB)
    expect(runtime.matched.actionCount(BLOCKER, TAB)).toBe(0)
  })

  it('keeps allowAllRequests that matched on the navigation method or response headers', async () => {
    const { session, runtime } = await loadedSession(
      blocker([
        { id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } },
        {
          id: 2,
          priority: 2,
          condition: {
            requestDomains: ['site.example'],
            resourceTypes: ['main_frame'],
            responseHeaders: [{ header: 'x-allow', values: ['yes'] }]
          },
          action: { type: 'allowAllRequests' }
        },
        {
          id: 3,
          priority: 2,
          condition: {
            requestDomains: ['form.example'],
            resourceTypes: ['main_frame'],
            requestMethods: ['post']
          },
          action: { type: 'allowAllRequests' }
        }
      ])
    )
    const frame = { frameTreeNodeId: 1, origin: '', parent: null, isDestroyed: () => false }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DNR code reads only these frame members.
    const mainFrame = frame as unknown as Electron.WebFrameMain
    const navigate = (url: string, method: string, responseHeaders: Record<string, string[]>) => {
      frame.origin = new URL(url).origin
      const request = details(url, { resourceType: 'mainFrame', method, frame: mainFrame })
      decider.beforeRequest(session, request)
      decider.headersReceived(session, headersReceived(request, responseHeaders))
      runtime.frames.commit(runtime.engine, TAB, mainFrame, url)
      return decider.beforeRequest(
        session,
        details('https://ads.example/a.js', { frame: mainFrame })
      )
    }
    expect(navigate('https://site.example/', 'GET', { 'X-Allow': ['yes'] })).toBeNull()
    expect(navigate('https://site.example/', 'GET', {})).toEqual({ cancel: true })
    expect(navigate('https://form.example/submit', 'POST', {})).toBeNull()
    expect(navigate('https://form.example/submit', 'GET', {})).toEqual({ cancel: true })
  })

  it("shows blocked requests on the tab's badge once asked, and restarts it per document", async () => {
    const extension = blocker([
      { id: 1, condition: { urlFilter: '||ads.example^' }, action: { type: 'block' } }
    ])
    const { session, runtime } = await loadedSession(extension)
    decider.beforeRequest(session, details('https://ads.example/1.js'))
    runtime.setDisplayActionCount(BLOCKER, true)
    decider.beforeRequest(session, details('https://ads.example/2.js'))
    const badge = () =>
      getBrowserExtensionActionState(runtime.profileId, extension).get(TAB).badgeText
    expect(badge()).toBe('2')
    getBrowserExtensionActionState(runtime.profileId, extension).forgetTab(TAB)
    runtime.matched.commitNavigation(TAB)
    expect(badge()).toBe('')
  })
})
