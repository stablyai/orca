import { EventEmitter } from 'node:events'
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
const contexts = await import('./browser-extension-contexts')
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
    event: {
      senderFrame: frame,
      sender: Object.assign(new EventEmitter(), { id: 77, session: sess })
    }
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

describe('extension frame document ownership', () => {
  const listen = { type: 'listen', namespace: 'probe', event: 'onPing', active: true }

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
    'retires %s listeners while preserving other owners',
    async (retirement) => {
      const original = frameEvent(
        `chrome-extension://${EXTENSION_ID}/page.html`,
        extensionSession,
        6,
        1
      )
      const sibling = frameEvent(
        `chrome-extension://${EXTENSION_ID}/sibling.html`,
        extensionSession,
        6,
        2
      )
      sibling.event.sender.id = 88
      await expect(invoke(original.event, listen)).resolves.toEqual({ ok: true, value: undefined })
      await invoke(sibling.event, listen)
      if (retirement === 'destroyed') {
        for (const property of ['session', 'id']) {
          Object.defineProperty(original.event.sender, property, {
            get: () => {
              throw new TypeError('Object has been destroyed')
            }
          })
        }
      }
      original.event.sender.emit(retirement)
      host.emitBrowserExtensionEvent({}, 'probe', 'onPing', ['after retirement'])
      expect(original.frame.send).not.toHaveBeenCalled()
      expect(sibling.frame.send).toHaveBeenCalledTimes(1)
      for (const event of ['did-navigate', 'render-process-gone', 'destroyed']) {
        expect(original.event.sender.listenerCount(event)).toBe(0)
      }
      if (retirement !== 'destroyed') {
        const successor = frameEvent(
          `chrome-extension://${EXTENSION_ID}/new.html`,
          extensionSession,
          6,
          3
        )
        successor.event.sender = original.event.sender
        await invoke(successor.event, listen)
        host.emitBrowserExtensionEvent({}, 'probe', 'onPing', ['successor'])
        expect(successor.frame.send).toHaveBeenCalledTimes(1)
        expect(original.frame.send).not.toHaveBeenCalled()
        expect(sibling.frame.send).toHaveBeenCalledTimes(2)
        successor.event.sender.emit('destroyed')
      }
      sibling.event.sender.emit('destroyed')
    }
  )

  it('keeps the current document on same-document and uncommitted navigation', async () => {
    const current = frameEvent(
      `chrome-extension://${EXTENSION_ID}/page.html`,
      extensionSession,
      7,
      1
    )
    await invoke(current.event, listen)
    current.event.sender.emit('did-navigate-in-page')
    current.event.sender.emit('will-navigate')
    host.emitBrowserExtensionEvent({}, 'probe', 'onPing', ['current'])
    expect(current.frame.send).toHaveBeenCalledTimes(1)
    current.event.sender.emit('destroyed')
  })

  it('stops the listener precheck after the last listening document is replaced', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session boundary exposes the extensions, serviceWorkers and protocol members consumed by the actual host.
    const isolated = { ...extensionSession } as unknown as Electron.Session
    host.attachBrowserExtensionApiHostToSession(isolated, 'isolated')
    const current = frameEvent(`chrome-extension://${EXTENSION_ID}/page.html`, isolated, 8, 1)
    await invoke(current.event, { ...listen, filters: [{ urls: ['https://never.invalid/*'] }] })
    expect(contexts.browserExtensionEventHasListener(isolated, 'probe', 'onPing')).toBe(true)
    current.event.sender.emit('did-navigate')
    expect(contexts.browserExtensionEventHasListener(isolated, 'probe', 'onPing')).toBe(false)
    expect(contexts.getHostSessionState(isolated)?.frames.size).toBe(0)
    host.forgetBrowserExtensionContexts(isolated)
  })
})

it('keeps service-worker event ownership when a page document is replaced', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session boundary copies the extensions, serviceWorkers and protocol members consumed by the actual host.
  const isolated = { ...extensionSession } as unknown as Electron.Session
  host.attachBrowserExtensionApiHostToSession(isolated, 'worker-survives')
  const state = contexts.getHostSessionState(isolated)
  expect(state).not.toBeNull()
  if (!state) {
    throw new Error('Session host was not attached')
  }
  const worker = contexts.ensureWorkerContext(
    state,
    EXTENSION_ID,
    `chrome-extension://${EXTENSION_ID}/`
  )
  worker.events.add('probe.onPing')
  const stream = { send: vi.fn(), close: vi.fn() }
  worker.stream = stream
  const page = frameEvent(`chrome-extension://${EXTENSION_ID}/page.html`, isolated, 9, 1)
  await invoke(page.event, { type: 'listen', namespace: 'probe', event: 'onPing', active: true })
  page.event.sender.emit('did-navigate')
  host.emitBrowserExtensionEvent({ session: isolated }, 'probe', 'onPing', ['worker'])
  expect(page.frame.send).not.toHaveBeenCalled()
  expect(stream.send).toHaveBeenCalledTimes(1)
  expect(stream.close).not.toHaveBeenCalled()
  host.forgetBrowserExtensionContexts(isolated)
})

it('retires the current host after extension support restarts in the same document', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the session boundary copies the extensions, serviceWorkers and protocol members consumed by the actual host.
  const isolated = { ...extensionSession } as unknown as Electron.Session
  host.attachBrowserExtensionApiHostToSession(isolated, 'restarted')
  const current = frameEvent(`chrome-extension://${EXTENSION_ID}/page.html`, isolated, 10, 1)
  const listen = { type: 'listen', namespace: 'probe', event: 'onPing', active: true }
  await invoke(current.event, listen)
  host.forgetBrowserExtensionContexts(isolated)
  host.attachBrowserExtensionApiHostToSession(isolated, 'restarted')
  await invoke(current.event, listen)
  current.event.sender.emit('did-navigate')
  expect(contexts.getHostSessionState(isolated)?.frames.size).toBe(0)
  expect(contexts.browserExtensionEventHasListener(isolated, 'probe', 'onPing')).toBe(false)
  host.forgetBrowserExtensionContexts(isolated)
})
