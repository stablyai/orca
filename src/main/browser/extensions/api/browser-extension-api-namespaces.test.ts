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
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    getWebContentsIdByTabId: () => new Map(),
    getGuestWebContentsId: (id: string) => (id === 'gesture-page' ? 700 : null)
  }
}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn()
}))
vi.mock('../../../runtime/browser/tabs/browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: vi.fn()
}))
vi.mock('../../../runtime/browser/tabs/browser-tab-renderer-close', () => ({
  closeBrowserTabInRenderer: vi.fn()
}))
vi.mock('../permissions/browser-extension-permission-prompt', () => ({
  askToGrantBrowserExtensionPermissions: mocks.prompt
}))

mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-apis-'))

const { BROWSER_EXTENSION_EVENT_CHANNEL, BROWSER_EXTENSION_INVOKE_CHANNEL } =
  await import('../../../../shared/browser/extensions/browser-extension-channels')
const registry = await import('../api-runtime/browser-extension-namespace-registry')
const host = await import('../api-runtime/browser-extension-api-host')
const { registerBrowserExtensionNamespaces } =
  await import('../register-browser-extension-namespaces')
await import('./permissions')
const { getBrowserExtensionProfileStateStore } =
  await import('../profile-storage/browser-extension-profile-state-store')
const menuHost = await import('../context-menus/browser-extension-context-menu-host')
const webRequest = await import('../requests/browser-extension-web-request-observer')
const { setBrowserExtensionSupportEnabled } = await import('../browser-extension-support')

await import('../../../../preload/browser/extensions/storage/browser-extension-storage-relay')
const { PRELOAD_STORAGE_SYNC_NAMESPACE } =
  await import('../../../../preload/browser/extensions/storage/browser-extension-storage-sync')

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
  protocol: { handle: vi.fn(), unhandle: vi.fn(), isProtocolHandled: vi.fn(() => true) },
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

  beforeEach(async () => {
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
