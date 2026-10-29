import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<
    string,
    (event: unknown, request: unknown, userGesture?: boolean) => Promise<unknown>
  >(),
  frames: new Map<
    string,
    { url: string; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  >(),
  contents: new Map<number, unknown>(),
  prompt: vi.fn<() => Promise<boolean>>()
}))

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = Object.assign(new EventEmitter(), { start: vi.fn(), close: vi.fn() })
    port2 = { close: vi.fn() }
  },
  app: { on: vi.fn(), getPath: () => mocks.userData },
  BrowserWindow: vi.fn(),
  Notification: { isSupported: () => false },
  session: { fromPartition: vi.fn() },
  webContents: { fromId: (id: number) => mocks.contents.get(id) },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (
      channel: string,
      handler: (event: unknown, request: unknown, userGesture?: boolean) => Promise<unknown>
    ) => mocks.handlers.set(channel, handler)
  },
  webFrameMain: {
    fromId: (processId: number, routingId: number) => mocks.frames.get(`${processId}:${routingId}`)
  }
}))
vi.mock('../browser-manager', () => ({
  browserManager: {
    getWebContentsIdByTabId: () => new Map(),
    getGuestWebContentsId: (id: string) => (id === 'gesture-page' ? 700 : null)
  }
}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({ waitForTabRegistration: vi.fn() }))
vi.mock('../../runtime/browser/browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: vi.fn()
}))
vi.mock('../../runtime/browser/browser-tab-renderer-close', () => ({
  closeBrowserTabInRenderer: vi.fn()
}))
vi.mock('./browser-extension-permission-prompt', () => ({
  askToGrantBrowserExtensionPermissions: mocks.prompt
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-apis-'))

const { BROWSER_EXTENSION_EVENT_CHANNEL, BROWSER_EXTENSION_INVOKE_CHANNEL } =
  await import('../../../shared/browser-extension-channels')
const registry = await import('./browser-extension-namespace-registry')
const host = await import('./browser-extension-api-host')
const { registerBrowserExtensionNamespaces } =
  await import('./register-browser-extension-namespaces')
const { noteBrowserExtensionUserGesture } = await import('./api/permissions')
const { getBrowserExtensionProfileStateStore } =
  await import('./browser-extension-profile-state-store')
const menuHost = await import('./browser-extension-context-menu-host')
const webRequest = await import('./browser-extension-web-request')
const { setBrowserExtensionSupportEnabled } = await import('./browser-extension-support')
const contexts = await import('./browser-extension-contexts')
const { attachWorkerEventStream } = await import('./browser-extension-worker-event-stream')
const { handleBrowserExtensionApiRequest } = await import('./browser-extension-api-request')
const { PRELOAD_STORAGE_RELAY_NAMESPACE } =
  await import('../../../preload/browser-extension-storage-relay')
const { PRELOAD_STORAGE_SYNC_NAMESPACE } =
  await import('../../../preload/browser-extension-storage-sync')

const VAULT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function makeExtension(id: string, manifest: Record<string, unknown>) {
  return { id, name: id === VAULT ? 'Vault' : 'Other', version: '1', path: '/x', url: '', manifest }
}

const extensions = new Map([
  [
    VAULT,
    makeExtension(VAULT, {
      permissions: ['contextMenus', 'scripting', 'cookies', 'storage'],
      optional_permissions: ['privacy'],
      host_permissions: ['https://*/*']
    })
  ],
  [OTHER, makeExtension(OTHER, { permissions: ['privacy', 'contextMenus', 'storage'] })]
])
const startWorkerForScope = vi.fn(() => Promise.resolve({}))
const cookieJar = [
  {
    name: 'sid',
    value: '1',
    domain: '.bank.test',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  },
  {
    name: 'pref',
    value: 'x',
    domain: 'plain.test',
    hostOnly: true,
    path: '/',
    secure: false,
    session: true,
    sameSite: 'unspecified'
  }
]
const cookies = {
  get: vi.fn(async (filter: { url?: string; name?: string }) =>
    cookieJar.filter(
      (cookie) =>
        (!filter.name || cookie.name === filter.name) &&
        (!filter.url || new URL(filter.url).hostname.endsWith(cookie.domain.replace(/^\./, '')))
    )
  ),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  on: vi.fn()
}
const extensionSession = {
  cookies,
  webRequest: {
    onSendHeaders: vi.fn(),
    onHeadersReceived: vi.fn(),
    onResponseStarted: vi.fn(),
    onBeforeRedirect: vi.fn(),
    onErrorOccurred: vi.fn(),
    onCompleted: vi.fn(
      (_filter: unknown, callback: (details: Record<string, unknown>) => void) => callback
    )
  },
  protocol: { handle: vi.fn(), unhandle: vi.fn() },
  extensions: Object.assign(new EventEmitter(), {
    getExtension: (id: string) => extensions.get(id) ?? null,
    getAllExtensions: () => [...extensions.values()]
  }),
  serviceWorkers: {
    on: vi.fn(),
    getAllRunning: () => ({}),
    getWorkerFromVersionID: vi.fn(),
    startWorkerForScope
  }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the APIs under test only touch the session members stubbed above.
const session = extensionSession as unknown as Electron.Session

function caller(extensionId: string, kind: 'worker' | 'page' = 'worker') {
  const extension = extensions.get(extensionId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers read id, name, path and manifest, all present on the stub.
  const asExtension = extension as unknown as Electron.Extension
  return {
    extension: asExtension,
    session,
    browserProfileId: 'default',
    ...(kind === 'worker'
      ? { fromWorker: true }
      : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only its presence marks a page caller.
        { webContents: {} as Electron.WebContents, userGesture: true })
  }
}

function call(
  extensionId: string,
  namespace: string,
  method: string,
  args: unknown[],
  kind?: 'worker' | 'page'
) {
  const target = registry.getBrowserExtensionNamespace(namespace)?.methods[method]
  if (!target) {
    throw new Error(`${namespace}.${method} is not registered`)
  }
  return new Promise((resolve) => resolve(target.invoke(caller(extensionId, kind), args)))
}

let nextRoutingId = 1

beforeAll(() => {
  setBrowserExtensionSupportEnabled(true)
  registerBrowserExtensionNamespaces()
  webRequest.installBrowserExtensionWebRequestForwarding()
  host.installBrowserExtensionApiHost()
  host.attachBrowserExtensionApiHostToSession(session, 'default')
})

beforeEach(() => {
  host.attachBrowserExtensionApiHostToSession(session, 'default')
  mocks.prompt.mockReset()
})

describe('permissions.request', () => {
  it.each(['extension unload', 'profile deletion'] as const)(
    'does not recreate grants when accepted after %s',
    async (reason) => {
      const extensionId = (reason === 'extension unload' ? 'd' : 'e').repeat(32)
      extensions.set(extensionId, makeExtension(extensionId, { optional_permissions: ['privacy'] }))
      let answer: (accepted: boolean) => void = () => {}
      mocks.prompt.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      const pending = call(
        extensionId,
        'permissions',
        'request',
        [{ permissions: ['privacy'] }],
        'page'
      )
      const store = getBrowserExtensionProfileStateStore()
      if (reason === 'extension unload') {
        extensionSession.extensions.emit('extension-unloaded', {}, extensions.get(extensionId))
        store.forgetExtension(extensionId)
      } else {
        host.forgetBrowserExtensionContexts(session)
        store.forgetProfile('default')
      }
      answer(true)
      await expect(pending).resolves.toBe(false)
      expect(store.readProfile('default')).not.toHaveProperty(extensionId)
      host.attachBrowserExtensionApiHostToSession(session, 'default')
    }
  )

  it('delivers a previously registered optional event only while permission is granted', async () => {
    const extensionId = 'f'.repeat(32)
    extensions.set(extensionId, makeExtension(extensionId, { optional_permissions: ['privacy'] }))
    const event = 'services.passwordSavingEnabled.onChange'
    const frame = await listenFrame(extensionId, 'privacy', event)
    const state = contexts.getHostSessionState(session)
    if (!state) {
      throw new Error('Session not attached')
    }
    const worker = contexts.ensureWorkerContext(
      state,
      extensionId,
      `chrome-extension://${extensionId}/`
    )
    const listen = () =>
      handleBrowserExtensionApiRequest(
        caller(extensionId),
        state,
        { type: 'listen', namespace: 'privacy', event, active: true },
        { kind: 'worker', context: worker }
      )
    await expect(listen()).resolves.toEqual({ ok: true, value: undefined })
    host.emitBrowserExtensionEvent({ session, extensionId }, 'privacy', event, [{ value: false }])
    expect(frame.payloads()).toEqual([])
    mocks.prompt.mockResolvedValueOnce(true)
    await call(extensionId, 'permissions', 'request', [{ permissions: ['privacy'] }], 'page')
    host.emitBrowserExtensionEvent({ session, extensionId }, 'privacy', event, [{ value: false }])
    expect(frame.payloads()).toEqual([[{ value: false }]])
    expect(worker.queue).toHaveLength(1)
    await call(extensionId, 'permissions', 'remove', [{ permissions: ['privacy'] }])
    const send = vi.fn()
    attachWorkerEventStream(worker, { send, close() {} })
    await expect(listen()).resolves.toEqual({ ok: true, value: undefined })
    expect(send).not.toHaveBeenCalled()
    host.emitBrowserExtensionEvent({ session, extensionId }, 'privacy', event, [{ value: true }])
    expect(frame.payloads()).toEqual([[{ value: false }]])
  })

  it('permits a worker permission request from its toolbar onClicked handler', async () => {
    const extensionId = 'g'.repeat(32)
    extensions.set(
      extensionId,
      makeExtension(extensionId, { action: {}, optional_permissions: ['privacy'] })
    )
    mocks.contents.set(700, {
      id: 700,
      session,
      isDestroyed: () => false,
      getType: () => 'webview'
    })
    const state = contexts.getHostSessionState(session)
    if (!state) {
      throw new Error('Session not attached')
    }
    const worker = contexts.ensureWorkerContext(
      state,
      extensionId,
      `chrome-extension://${extensionId}/`
    )
    worker.events.add(contexts.eventKey('action', 'onClicked'))
    let request: Promise<unknown> | undefined
    attachWorkerEventStream(worker, {
      send: () => {
        request = call(extensionId, 'permissions', 'request', [{ permissions: ['privacy'] }])
      },
      close() {}
    })
    const { activateBrowserExtensionAction } = await import('./browser-extension-toolbar')
    mocks.prompt.mockResolvedValueOnce(true)
    expect(
      activateBrowserExtensionAction({
        browserPageId: 'gesture-page',
        extensionId,
        anchor: { x: 0, y: 0, width: 20, height: 20 },
        popupOnly: false
      })
    ).toEqual({ ok: true })
    expect(request).toBeDefined()
    await expect(request).resolves.toBe(true)
    mocks.contents.delete(700)
  })

  it('begins delivering network events when optional webRequest permission is granted', async () => {
    const extensionId = 'h'.repeat(32)
    extensions.set(
      extensionId,
      makeExtension(extensionId, {
        optional_permissions: ['webRequest'],
        host_permissions: ['https://*/*']
      })
    )
    const frame = await listenFrame(extensionId, 'webRequest', 'onCompleted')
    webRequest.observeBrowserExtensionWebRequests(session)
    expect(extensionSession.webRequest.onCompleted).not.toHaveBeenCalled()
    mocks.prompt.mockResolvedValueOnce(true)
    await call(extensionId, 'permissions', 'request', [{ permissions: ['webRequest'] }], 'page')
    const completed = extensionSession.webRequest.onCompleted.mock.calls.at(-1)?.[1]
    expect(completed).toBeDefined()
    completed?.({
      id: 9,
      url: 'https://site.test/image.png',
      method: 'GET',
      resourceType: 'image',
      timestamp: 1,
      initiatorOrigin: 'https://site.test'
    })
    expect(frame.payloads()).toEqual([
      [expect.objectContaining({ url: 'https://site.test/image.png', type: 'image' })]
    ])
  })

  it('needs a user gesture in a worker, then prompts, persists the grant and fires onAdded', async () => {
    const frame = await listenFrame(VAULT, 'permissions', 'onAdded')
    await expect(
      call(VAULT, 'permissions', 'request', [{ permissions: ['privacy'] }])
    ).rejects.toThrow('This function must be called during a user gesture')
    expect(mocks.prompt).not.toHaveBeenCalled()

    mocks.prompt.mockResolvedValueOnce(true)
    noteBrowserExtensionUserGesture(session, VAULT)
    await expect(
      call(VAULT, 'permissions', 'request', [{ permissions: ['privacy'] }])
    ).resolves.toBe(true)
    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(frame.payloads()).toEqual([[{ permissions: ['privacy'], origins: [] }]])
    expect(
      getBrowserExtensionProfileStateStore().read('default', VAULT).grantedPermissions
    ).toEqual(['privacy'])
    // The grant now opens the namespace that needs it, and asking again does not prompt.
    expect(registry.extensionHasPermission(caller(VAULT).extension, 'privacy', session)).toBe(true)
    await expect(
      call(VAULT, 'permissions', 'contains', [{ permissions: ['privacy'] }])
    ).resolves.toBe(true)
    await expect(
      call(VAULT, 'permissions', 'request', [{ permissions: ['privacy'] }])
    ).resolves.toBe(true)
    expect(mocks.prompt).toHaveBeenCalledTimes(1)

    await expect(
      call(VAULT, 'permissions', 'remove', [{ permissions: ['privacy'] }])
    ).resolves.toBe(true)
    expect(registry.extensionHasPermission(caller(VAULT).extension, 'privacy', session)).toBe(false)
  })

  it('keeps nothing when the user declines, and refuses a second prompt while one is open', async () => {
    let answer: (accepted: boolean) => void = () => {}
    mocks.prompt.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const first = call(VAULT, 'permissions', 'request', [{ permissions: ['privacy'] }], 'page')
    await expect(
      call(VAULT, 'permissions', 'request', [{ permissions: ['privacy'] }], 'page')
    ).rejects.toThrow('A permissions request is already pending')
    answer(false)
    await expect(first).resolves.toBe(false)
    expect(
      getBrowserExtensionProfileStateStore().read('default', VAULT).grantedPermissions
    ).toEqual([])
  })
})

describe('privacy settings', () => {
  it('reports who controls a setting and tells other extensions when it changes', async () => {
    const otherFrame = await listenFrame(
      OTHER,
      'privacy',
      'services.passwordSavingEnabled.onChange'
    )
    await expect(
      call(OTHER, 'privacy', 'services.passwordSavingEnabled.get', [{}])
    ).resolves.toEqual({ value: true, levelOfControl: 'controllable_by_this_extension' })

    getBrowserExtensionProfileStateStore().update('default', VAULT, (state) => ({
      ...state,
      grantedPermissions: ['privacy']
    }))
    await call(VAULT, 'privacy', 'services.passwordSavingEnabled.set', [{ value: false }])
    await expect(
      call(VAULT, 'privacy', 'services.passwordSavingEnabled.get', [{}])
    ).resolves.toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(otherFrame.payloads()).toEqual([
      [{ value: false, levelOfControl: 'controlled_by_other_extensions' }]
    ])
    await expect(
      call(VAULT, 'privacy', 'network.networkPredictionEnabled.set', [{ value: false }])
    ).rejects.toThrow('cannot be changed in Orca')
    // Privacy Badger reads these and only writes settings it may control.
    await expect(call(OTHER, 'privacy', 'websites.topicsEnabled.get', [{}])).resolves.toEqual({
      value: false,
      levelOfControl: 'not_controllable'
    })
  })
})

describe('action icons', () => {
  it('reads icon paths as Chrome resolves them: against the worker script, or own URLs', async () => {
    const { getBrowserExtensionActionState } = await import('./browser-extension-action-registry')
    const manifest = extensions.get(VAULT)?.manifest ?? {}
    manifest.background = { service_worker: 'scripts/orca-background.js' }
    try {
      await call(VAULT, 'action', 'setIcon', [
        {
          path: {
            16: `chrome-extension://${VAULT}/images/grey16.png`,
            32: '../icons/enabled 32.png',
            48: 'https://example.com/icon.png'
          }
        }
      ])
    } finally {
      delete manifest.background
    }
    expect(
      getBrowserExtensionActionState('default', caller(VAULT).extension).get(null).icon
    ).toEqual({
      kind: 'path',
      paths: {
        16: 'images/grey16.png',
        32: 'icons/enabled 32.png',
        48: 'https://example.com/icon.png'
      }
    })
  })
})

describe('storage change relay', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a second profile session over the same stubbed members.
  const secondSession = { ...extensionSession } as unknown as Electron.Session

  function listeningWorker(sess: Electron.Session, extensionId: string) {
    const state = contexts.getHostSessionState(sess)
    if (!state) {
      throw new Error('Session is not attached')
    }
    const context = contexts.ensureWorkerContext(
      state,
      extensionId,
      `chrome-extension://${extensionId}/`
    )
    context.events.add(contexts.eventKey(PRELOAD_STORAGE_RELAY_NAMESPACE, 'onChanged'))
    const send = vi.fn()
    attachWorkerEventStream(context, { send, close: vi.fn() })
    return send
  }

  it('forwards a page write only to the same extension worker in the same session', async () => {
    host.attachBrowserExtensionApiHostToSession(secondSession, 'work')
    const vaultWorker = listeningWorker(session, VAULT)
    const otherWorker = listeningWorker(session, OTHER)
    const vaultElsewhere = listeningWorker(secondSession, VAULT)
    const changes = { token: { oldValue: 'a', newValue: 'b' }, added: { newValue: [1] } }

    await call(VAULT, PRELOAD_STORAGE_RELAY_NAMESPACE, 'report', ['session', changes], 'page')
    expect(vaultWorker.mock.calls).toEqual([
      [
        {
          namespace: PRELOAD_STORAGE_RELAY_NAMESPACE,
          event: 'onChanged',
          args: [changes, 'session']
        }
      ]
    ])
    expect(otherWorker).not.toHaveBeenCalled()
    expect(vaultElsewhere).not.toHaveBeenCalled()
    const { BROWSER_EXTENSION_API_SURFACE } =
      await import('../../../preload/browser-extension-api-surface')
    expect(BROWSER_EXTENSION_API_SURFACE).not.toHaveProperty(PRELOAD_STORAGE_RELAY_NAMESPACE)
  })

  it('refuses reports from the worker and malformed changes', async () => {
    await expect(
      call(VAULT, PRELOAD_STORAGE_RELAY_NAMESPACE, 'report', ['local', {}], 'worker')
    ).rejects.toThrow('The worker delivers its own storage changes')
    await expect(
      call(VAULT, PRELOAD_STORAGE_RELAY_NAMESPACE, 'report', ['managed', {}], 'page')
    ).rejects.toThrow('Invalid arguments at 0')
    await expect(
      call(VAULT, PRELOAD_STORAGE_RELAY_NAMESPACE, 'report', ['local', { a: { value: 1 } }], 'page')
    ).rejects.toThrow('Invalid arguments at 1.a')
  })
})

describe('context menus in the page menu', () => {
  const guest = {
    id: 900,
    session,
    getURL: () => 'https://site.test/login'
  }
  function rightClick(params: Partial<Electron.ContextMenuParams>) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder reads only session, id and getURL.
    const contents = guest as unknown as Electron.WebContents
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unspecified params are read as absent.
    return menuHost.buildBrowserExtensionPageContextMenu(contents, {
      isEditable: false,
      mediaType: 'none',
      frame: null,
      ...params
    } as unknown as Electron.ContextMenuParams)
  }

  it('groups items per extension and runs onClicked with OnClickData', async () => {
    await call(VAULT, 'contextMenus', 'removeAll', [])
    await call(VAULT, 'contextMenus', 'create', [
      { id: 'fill', title: 'Fill', contexts: ['editable'] }
    ])
    await call(VAULT, 'contextMenus', 'create', [
      { id: 'remember', title: 'Remember', type: 'checkbox', contexts: ['editable'] }
    ])
    await call(OTHER, 'contextMenus', 'create', [{ id: 9, title: 'Other item', contexts: ['all'] }])
    const clicks = await listenFrame(VAULT, 'contextMenus', 'onClicked')

    const menu = rightClick({ isEditable: true, selectionText: '' })
    expect(menu?.groups).toEqual([
      { extensionId: OTHER, items: [expect.objectContaining({ key: '9', title: 'Other item' })] },
      {
        extensionId: VAULT,
        items: [
          expect.objectContaining({
            key: '',
            title: 'Vault',
            children: [
              expect.objectContaining({ key: '"fill"' }),
              expect.objectContaining({ key: '"remember"', type: 'checkbox', checked: false })
            ]
          })
        ]
      }
    ])
    expect(rightClick({})?.groups.map((group) => group.extensionId)).toEqual([OTHER])

    const token = menu?.token ?? ''
    expect(
      menuHost.runBrowserExtensionContextMenuClick({ token, extensionId: VAULT, key: '"remember"' })
    ).toBe(true)
    expect(clicks.payloads()).toEqual([
      [
        {
          menuItemId: 'remember',
          pageUrl: 'https://site.test/login',
          frameId: 0,
          editable: true,
          wasChecked: false,
          checked: true
        }
      ]
    ])
    // A token is spent by its click, and the checkbox state is kept.
    expect(
      menuHost.runBrowserExtensionContextMenuClick({ token, extensionId: VAULT, key: '"fill"' })
    ).toBe(false)
    expect(
      getBrowserExtensionProfileStateStore().read('default', VAULT).contextMenus[1].checked
    ).toBe(true)
  })

  it('refuses ids the extension already used', async () => {
    await expect(
      call(OTHER, 'contextMenus', 'create', [{ id: 9, title: 'Again' }])
    ).rejects.toThrow('Cannot create item with duplicate id 9')
  })
})

describe('cookies', () => {
  it('needs host permission, reads Chrome-shaped cookies and hides hosts it cannot see', async () => {
    await expect(
      call(VAULT, 'cookies', 'get', [{ url: 'https://www.bank.test/', name: 'sid' }])
    ).resolves.toEqual({
      name: 'sid',
      value: '1',
      domain: '.bank.test',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      storeId: '0'
    })
    await expect(
      call(VAULT, 'cookies', 'get', [{ url: 'http://plain.test/', name: 'pref' }])
    ).rejects.toThrow('No host permissions for cookies at url: "http://plain.test/".')
    // getAll without a URL returns only cookies on hosts the extension may access (https here).
    const all = await call(VAULT, 'cookies', 'getAll', [{}])
    expect(Array.isArray(all) ? all.map((cookie) => cookie.name) : all).toEqual(['sid'])
    expect(cookies.get).toHaveBeenLastCalledWith({})
    await expect(
      call(VAULT, 'cookies', 'get', [{ url: 'https://www.bank.test/', name: 'sid', storeId: '1' }])
    ).rejects.toThrow('Invalid cookie store id: "1".')
    await expect(call(VAULT, 'cookies', 'getAllCookieStores', [])).resolves.toEqual([
      { id: '0', tabIds: [] }
    ])
  })
})

describe('webRequest forwarding', () => {
  it('maps Electron details to Chrome details and pre-filters by listener filter', () => {
    const details = webRequest.toChromeWebRequestDetails(
      {
        id: 41,
        url: 'https://site.test/login',
        method: 'POST',
        resourceType: 'mainFrame',
        timestamp: 5,
        requestHeaders: { Cookie: 'sid=1', 'Content-Type': 'application/x-www-form-urlencoded' },
        statusCode: 302,
        redirectURL: 'https://site.test/home'
      },
      { tabId: 7, windowId: 1 },
      { frameId: 0, parentFrameId: -1, frameType: 'outermost_frame', documentLifecycle: 'active' }
    )
    expect(details).toEqual({
      requestId: '41',
      url: 'https://site.test/login',
      method: 'POST',
      frameId: 0,
      parentFrameId: -1,
      tabId: 7,
      windowId: 1,
      type: 'main_frame',
      timeStamp: 5,
      frameType: 'outermost_frame',
      documentLifecycle: 'active',
      requestHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      statusCode: 302,
      redirectUrl: 'https://site.test/home'
    })
    expect(
      webRequest.webRequestFilterMatches(
        { urls: ['https://site.test/*'], types: ['main_frame'] },
        details
      )
    ).toBe(true)
    expect(
      webRequest.webRequestFilterMatches({ urls: ['<all_urls>'], types: ['image'] }, details)
    ).toBe(false)
    expect(webRequest.webRequestFilterMatches({ urls: ['https://other.test/*'] }, details)).toBe(
      false
    )
    expect(webRequest.webRequestFilterMatches({ urls: ['<all_urls>'], tabId: 8 }, details)).toBe(
      false
    )
  })
})

describe('storage.sync', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: another profile session over the same stubbed members.
  const workSession = { ...extensionSession } as unknown as Electron.Session
  const SYNC = PRELOAD_STORAGE_SYNC_NAMESPACE

  function sync(
    method: string,
    args: unknown[],
    who: { extensionId?: string; profile?: 'default' | 'work'; kind?: 'worker' | 'page' } = {}
  ) {
    const target = registry.getBrowserExtensionNamespace(SYNC)?.methods[method]
    const base = caller(who.extensionId ?? VAULT, who.kind)
    const inWork = who.profile === 'work'
    return new Promise((resolve) =>
      resolve(
        target?.invoke(
          {
            ...base,
            session: inWork ? workSession : session,
            browserProfileId: inWork ? 'work' : 'default'
          },
          args
        )
      )
    )
  }

  function listeningWorker(sess: Electron.Session, extensionId: string) {
    const state = contexts.getHostSessionState(sess)
    if (!state) {
      throw new Error('Session is not attached')
    }
    const context = contexts.ensureWorkerContext(
      state,
      extensionId,
      `chrome-extension://${extensionId}/`
    )
    context.events.add(contexts.eventKey(SYNC, 'onChanged'))
    const send = vi.fn()
    attachWorkerEventStream(context, { send, close: vi.fn() })
    return { changes: () => send.mock.calls.map(([payload]) => payload.args) }
  }

  beforeEach(async () => {
    await sync('clear', [])
  })

  it('reads with every Chrome key form and keeps values as JSON', async () => {
    await sync('set', [{ theme: { dark: true }, size: 3, when: new Date(0), fn: () => 1 }])
    await expect(sync('get', [null])).resolves.toEqual({
      theme: { dark: true },
      size: 3,
      when: '1970-01-01T00:00:00.000Z'
    })
    await expect(sync('get', [])).resolves.toEqual(expect.objectContaining({ size: 3 }))
    await expect(sync('get', ['size'])).resolves.toEqual({ size: 3 })
    await expect(sync('get', [['size', 'missing']])).resolves.toEqual({ size: 3 })
    await expect(sync('get', [{ size: 0, missing: 'fallback' }])).resolves.toEqual({
      size: 3,
      missing: 'fallback'
    })
    await expect(sync('getKeys', [])).resolves.toEqual(['theme', 'size', 'when'])
    // Chrome counts key + JSON bytes: "size" + "3".
    await expect(sync('getBytesInUse', ['size'])).resolves.toBe(5)
    await expect(sync('get', [7])).rejects.toThrow('Invalid arguments at 0')
    await sync('clear', [])
  })

  it('sends exact old and new values to the extension pages and worker in that session only', async () => {
    host.attachBrowserExtensionApiHostToSession(workSession, 'work')
    const worker = listeningWorker(session, VAULT)
    const page = await listenFrame(VAULT, SYNC, 'onChanged')
    const otherExtension = listeningWorker(session, OTHER)
    const otherProfile = listeningWorker(workSession, VAULT)
    const fromPage = { kind: 'page' } as const

    const written = { a: { newValue: 1 }, b: { newValue: { deep: [1] } } }
    // The writer gets its changes back and fires its own listeners.
    await expect(sync('set', [{ a: 1, b: { deep: [1] } }], fromPage)).resolves.toEqual(written)
    await sync('set', [{ a: 1, b: { deep: [2] } }], fromPage)
    await expect(sync('set', [{ a: 1 }], fromPage)).resolves.toEqual({})
    await sync('remove', [['a', 'missing']], fromPage)
    await sync('clear', [], fromPage)
    await sync('clear', [], fromPage)
    const expected = [
      [written],
      [{ b: { oldValue: { deep: [1] }, newValue: { deep: [2] } } }],
      [{ a: { oldValue: 1 } }],
      [{ b: { oldValue: { deep: [2] } } }]
    ]
    expect(worker.changes()).toEqual(expected)
    expect(page.payloads()).toEqual(expected)
    expect(otherExtension.changes()).toEqual([])
    expect(otherProfile.changes()).toEqual([])

    await sync('set', [{ fromWorker: 1 }])
    expect(worker.changes()).toHaveLength(4)
    expect(page.payloads().at(-1)).toEqual([{ fromWorker: { newValue: 1 } }])

    await sync('set', [{ mine: true }])
    await expect(sync('get', [null], { extensionId: OTHER })).resolves.toEqual({})
    await expect(sync('get', [null], { profile: 'work' })).resolves.toEqual({})
    await sync('clear', [])
  })

  it('validates an atomic batch against its final size regardless of key order', async () => {
    const initial = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`key${index}`, 'x'.repeat(8000)])
    )
    await sync('set', [initial])
    await expect(sync('set', [{ newKey: 'y'.repeat(8000), key0: 'short' }])).resolves.toBeDefined()
    await expect(sync('getBytesInUse', [])).resolves.toBe(96087)
    await expect(sync('get', ['key0'])).resolves.toEqual({ key0: 'short' })
    await sync('clear', [])
  })

  it("fails a write that breaks Chrome's quotas and stores none of it", async () => {
    await expect(sync('set', [{ big: 'x'.repeat(8192) }])).rejects.toThrow(
      'QUOTA_BYTES_PER_ITEM quota exceeded'
    )
    // Each item fits; 13 of them do not.
    const items = Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [`k${index}`, 'x'.repeat(8000)])
    )
    await expect(sync('set', [items])).rejects.toThrow('QUOTA_BYTES quota exceeded')
    const many = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`n${index}`, 1]))
    await expect(sync('set', [many])).rejects.toThrow('MAX_ITEMS quota exceeded')
    await expect(sync('getBytesInUse', [null])).resolves.toBe(0)
    await sync('set', [{ edge: 'x'.repeat(8192 - 'edge'.length - 2) }])
    await expect(sync('getBytesInUse', [])).resolves.toBe(8192)
    await sync('clear', [])
  })
})

/** Registers a listening frame and reads what it was sent. */
async function listenFrame(extensionId: string, namespace: string, event: string) {
  const routingId = nextRoutingId++
  const frame = {
    url: `chrome-extension://${extensionId}/page.html`,
    origin: `chrome-extension://${extensionId}`,
    processId: 3,
    routingId,
    isDestroyed: () => false,
    send: vi.fn(),
    postMessage: vi.fn()
  }
  mocks.frames.set(`3:${routingId}`, frame)
  await mocks.handlers.get(BROWSER_EXTENSION_INVOKE_CHANNEL)?.(
    {
      senderFrame: frame,
      sender: Object.assign(new EventEmitter(), { id: 40 + routingId, session })
    },
    { type: 'listen', namespace, event, active: true }
  )
  return {
    payloads: (): unknown[] =>
      frame.send.mock.calls
        .filter(([channel]) => channel === BROWSER_EXTENSION_EVENT_CHANNEL)
        .map(([, payload]) => payload.args)
  }
}

describe('chrome.extension access checks', () => {
  it('reports no file or incognito access, matching how Orca loads extensions', async () => {
    expect(await call(VAULT, 'extension', 'isAllowedFileSchemeAccess', [])).toBe(false)
    expect(await call(VAULT, 'extension', 'isAllowedIncognitoAccess', [])).toBe(false)
  })
})
