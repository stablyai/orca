import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

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
const { getBrowserExtensionActionState } = await import('./browser-extension-action-registry')

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime touches only these session members.
  const session = {
    extensions: { on: vi.fn(), getAllExtensions: () => loaded },
    webRequest: { onHeadersReceived: vi.fn() }
  } as unknown as Electron.Session
  attachBrowserExtensionDnr(session, `profile-${Math.random()}`, [extension.id])
  const runtime = getDnrSessionRuntime(session)
  if (!runtime) {
    throw new Error('runtime missing')
  }
  return { session, runtime }
}

async function loadedSession(extension: Electron.Extension) {
  const { session, runtime } = sessionWith(extension)
  await runtime.whenLoaded()
  return { session, runtime }
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
