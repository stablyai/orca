import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  userData: '',
  prompt: vi.fn<() => Promise<boolean>>(),
  handlers: new Map<
    string,
    (event: unknown, request: unknown, userGesture?: boolean) => Promise<unknown>
  >(),
  frames: new Map<
    string,
    { url: string; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  >()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => mocks.userData },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
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
vi.mock('../browser-manager', () => ({ browserManager: {} }))
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
mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-api-host-'))

const { BROWSER_EXTENSION_EVENT_CHANNEL, BROWSER_EXTENSION_INVOKE_CHANNEL } =
  await import('../../../shared/browser-extension-channels')
const surface = await import('../../../preload/browser-extension-api-surface')
const registry = await import('./browser-extension-namespace-registry')
const host = await import('./browser-extension-api-host')
const { registerBrowserExtensionNamespaces } =
  await import('./register-browser-extension-namespaces')

const EXTENSION_ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)

function makeExtension(id: string, permissions: string[]): Electron.Extension {
  return { id, name: id, version: '1', path: '', url: '', manifest: { permissions } }
}

const extensions = new Map([
  [EXTENSION_ID, makeExtension(EXTENSION_ID, ['probe'])],
  [OTHER_ID, makeExtension(OTHER_ID, [])]
])
const extensionSession = {
  extensions: {
    getExtension: (id: string) => extensions.get(id) ?? null,
    getAllExtensions: () => [...extensions.values()],
    on: vi.fn()
  },
  serviceWorkers: { on: vi.fn(), getAllRunning: () => ({}), getWorkerFromVersionID: vi.fn() },
  protocol: { handle: vi.fn(), unhandle: vi.fn() }
}
const handled: unknown[][] = []

function frameEvent(
  url: string,
  sess: unknown = extensionSession,
  processId = 4,
  routingId = 9,
  // Node reports "null" for chrome-extension: URLs; Chromium reports the real extension origin.
  origin = url.split('/').slice(0, 3).join('/')
) {
  const frame = { url, origin, processId, routingId, isDestroyed: () => false, send: vi.fn() }
  mocks.frames.set(`${processId}:${routingId}`, frame)
  return {
    frame,
    event: { senderFrame: frame, sender: { id: 77, session: sess, once: vi.fn() } }
  }
}

function invoke(event: unknown, request: unknown, userGesture?: boolean): Promise<unknown> {
  const handler = mocks.handlers.get(BROWSER_EXTENSION_INVOKE_CHANNEL)
  if (!handler) {
    throw new Error('host not installed')
  }
  return handler(event, request, userGesture)
}

beforeAll(() => {
  registerBrowserExtensionNamespaces()
  registry.registerBrowserExtensionNamespace('probe', {
    permission: 'probe',
    methods: {
      echo: registry.defineBrowserExtensionMethod(
        z.tuple([z.object({ value: z.number() })]),
        (caller, details) => {
          handled.push([caller.extension.id, details])
          return details.value * 2
        }
      )
    },
    events: ['onPing']
  })
  host.installBrowserExtensionApiHost()
  host.attachBrowserExtensionApiHostToSession(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host only touches the extensions and serviceWorkers members stubbed above.
    extensionSession as unknown as Electron.Session,
    'default'
  )
})

describe('preload API surface', () => {
  it('pins the preload channel copies to the ones main listens on', () => {
    expect(surface.PRELOAD_BROWSER_EXTENSION_INVOKE_CHANNEL).toBe(BROWSER_EXTENSION_INVOKE_CHANNEL)
    expect(surface.PRELOAD_BROWSER_EXTENSION_EVENT_CHANNEL).toBe(BROWSER_EXTENSION_EVENT_CHANNEL)
  })

  it('installs exactly what main registers, under the same permission', () => {
    for (const [name, spec] of Object.entries(surface.BROWSER_EXTENSION_API_SURFACE)) {
      const namespace = registry.getBrowserExtensionNamespace(name)
      expect(namespace, name).not.toBeNull()
      expect(Object.keys(spec.methods).sort(), name).toEqual(
        Object.keys(namespace?.methods ?? {}).sort()
      )
      expect([...spec.events].sort(), name).toEqual([...(namespace?.events ?? [])].sort())
      expect(spec.permission, name).toEqual(namespace?.permission)
    }
  })
})

describe('extension API host', () => {
  it('accepts only isolated-preload activation and ignores an extension-supplied gesture', async () => {
    const id = 'd'.repeat(32)
    extensions.set(id, {
      ...makeExtension(id, []),
      manifest: { optional_permissions: ['privacy'] }
    })
    const { event } = frameEvent(`chrome-extension://${id}/page.html`)
    const request = {
      type: 'call',
      namespace: 'permissions',
      method: 'request',
      args: [{ permissions: ['privacy'] }]
    }
    const denied = { ok: false, error: 'This function must be called during a user gesture' }
    await expect(invoke(event, request)).resolves.toEqual(denied)
    await expect(invoke(event, { ...request, userGesture: true })).resolves.toEqual(denied)
    expect(mocks.prompt).not.toHaveBeenCalled()
    mocks.prompt.mockResolvedValueOnce(true)
    await expect(invoke(event, request, true)).resolves.toEqual({ ok: true, value: true })
  })

  it('takes the caller from the sender frame and returns the handler result', async () => {
    const { event } = frameEvent(`chrome-extension://${EXTENSION_ID}/popup.html`)
    await expect(
      invoke(event, { type: 'call', namespace: 'probe', method: 'echo', args: [{ value: 21 }] })
    ).resolves.toEqual({ ok: true, value: 42 })
    expect(handled.at(-1)).toEqual([EXTENSION_ID, { value: 21 }])
  })

  it('refuses web pages, extensions not loaded in that session, and unknown sessions', async () => {
    const request = { type: 'call', namespace: 'probe', method: 'echo', args: [{ value: 1 }] }
    const notExtension = { ok: false, error: 'Not an extension context' }
    await expect(invoke(frameEvent('https://example.com/').event, request)).resolves.toEqual(
      notExtension
    )
    await expect(
      invoke(frameEvent(`chrome-extension://${'c'.repeat(32)}/x.html`).event, request)
    ).resolves.toEqual(notExtension)
    // A manifest sandbox page: its extension URL stays, but Chromium gives it an opaque origin.
    await expect(
      invoke(
        frameEvent(
          `chrome-extension://${EXTENSION_ID}/sandboxed.html`,
          extensionSession,
          4,
          9,
          'null'
        ).event,
        request
      )
    ).resolves.toEqual(notExtension)
    await expect(
      invoke(
        frameEvent(`chrome-extension://${EXTENSION_ID}/x.html`, {
          extensions: extensionSession.extensions
        }).event,
        request
      )
    ).resolves.toEqual(notExtension)
  })

  it('enforces the namespace permission and validates arguments', async () => {
    const otherCaller = frameEvent(`chrome-extension://${OTHER_ID}/popup.html`).event
    await expect(
      invoke(otherCaller, {
        type: 'call',
        namespace: 'probe',
        method: 'echo',
        args: [{ value: 1 }]
      })
    ).resolves.toEqual({ ok: false, error: 'This API requires the "probe" permission' })

    const caller = frameEvent(`chrome-extension://${EXTENSION_ID}/popup.html`).event
    await expect(
      invoke(caller, { type: 'call', namespace: 'probe', method: 'echo', args: [{ value: 'x' }] })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid arguments at 0.value')
    })
    await expect(
      invoke(caller, { type: 'call', namespace: 'probe', method: 'toString', args: [] })
    ).resolves.toEqual({ ok: false, error: 'chrome.probe.toString is not available' })
  })

  it('delivers events only to frames that registered a listener', async () => {
    const listening = frameEvent(
      `chrome-extension://${EXTENSION_ID}/a.html`,
      extensionSession,
      5,
      1
    )
    const silent = frameEvent(`chrome-extension://${EXTENSION_ID}/b.html`, extensionSession, 5, 2)
    await invoke(listening.event, {
      type: 'listen',
      namespace: 'probe',
      event: 'onPing',
      active: true
    })

    host.emitBrowserExtensionEvent({}, 'probe', 'onPing', [{ n: 1 }])
    expect(listening.frame.send).toHaveBeenCalledWith(BROWSER_EXTENSION_EVENT_CHANNEL, {
      namespace: 'probe',
      event: 'onPing',
      args: [{ n: 1 }]
    })
    expect(silent.frame.send).not.toHaveBeenCalled()

    await invoke(listening.event, {
      type: 'listen',
      namespace: 'probe',
      event: 'onPing',
      active: false
    })
    host.emitBrowserExtensionEvent({}, 'probe', 'onPing', [{ n: 2 }])
    expect(listening.frame.send).toHaveBeenCalledTimes(1)
  })
})
