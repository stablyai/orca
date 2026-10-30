import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

type PortStub = EventEmitter & { close: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> }

const mocks = vi.hoisted(() => ({
  channels: new Array<{ port1: PortStub; port2: PortStub }>(),
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

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Port extends EventEmitter {
    close = vi.fn(() => this.emit('close'))
    start = vi.fn()
  }
  return {
    MessageChannelMain: class {
      port1 = new Port()
      port2 = new Port()
      constructor() {
        mocks.channels.push(this)
      }
    },
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
      fromId: (processId: number, routingId: number) =>
        mocks.frames.get(`${processId}:${routingId}`)
    }
  }
})
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

const {
  BROWSER_EXTENSION_EVENT_CHANNEL,
  BROWSER_EXTENSION_INVOKE_CHANNEL,
  BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL
} = await import('../../../shared/browser-extension-channels')
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
  const frame = {
    url,
    origin,
    processId,
    routingId,
    isDestroyed: () => false,
    send: vi.fn(),
    postMessage: vi.fn()
  }
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
    expect(surface.PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL).toBe(
      BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL
    )
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

describe('extension subframe listener retirement', () => {
  const listen = { type: 'listen', namespace: 'probe', event: 'onPing', active: true }

  function isolatedSession() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: host calls use the copied session members already exercised by the host fixtures.
    const sess = { ...extensionSession } as unknown as Electron.Session
    host.attachBrowserExtensionApiHostToSession(sess, 'subframes')
    const state = contexts.getHostSessionState(sess)
    if (!state) {
      throw new Error('Missing session host')
    }
    return { sess, state }
  }

  function channel() {
    const current = mocks.channels.at(-1)
    if (!current) {
      throw new Error('Listening frame did not acquire a native port')
    }
    return current
  }

  it('retires a detached filtered frame without dispatch or document navigation', async () => {
    const { sess, state } = isolatedSession()
    const page = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 20, 1)
    await invoke(page.event, { ...listen, filters: [{ urls: ['https://never.invalid/*'] }] })
    expect(contexts.browserExtensionEventHasListener(sess, 'probe', 'onPing')).toBe(true)
    channel().port1.emit('close')
    expect(state.frames.size).toBe(0)
    expect(contexts.browserExtensionEventHasListener(sess, 'probe', 'onPing')).toBe(false)
    host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', ['removed'])
    expect(page.frame.send).not.toHaveBeenCalled()
    host.forgetBrowserExtensionContexts(sess)
  })

  it('shares one port across listeners and replaces it after final removal', async () => {
    const { sess, state } = isolatedSession()
    const page = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 21, 1)
    await invoke(page.event, listen)
    const first = channel()
    const lateClose = first.port1.listeners('close')[0]
    await invoke(page.event, listen)
    await invoke(page.event, { ...listen, namespace: 'tabs', event: 'onCreated' })
    expect(page.frame.postMessage).toHaveBeenCalledTimes(1)
    await invoke(page.event, { ...listen, active: false })
    expect(state.frames.size).toBe(1)
    expect(first.port1.close).not.toHaveBeenCalled()
    await invoke(page.event, { ...listen, namespace: 'tabs', event: 'onCreated', active: false })
    expect(state.frames.size).toBe(0)
    expect(first.port1.close).toHaveBeenCalledTimes(1)
    expect(first.port1.listenerCount('close')).toBe(0)
    await invoke(page.event, listen)
    expect(channel()).not.toBe(first)
    lateClose?.()
    host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', ['successor'])
    expect(page.frame.send).toHaveBeenCalledTimes(1)
    expect(state.frames.size).toBe(1)
    host.forgetBrowserExtensionContexts(sess)
  })

  it('preserves sibling frames, windows, sessions and worker listeners', async () => {
    const { sess, state } = isolatedSession()
    const elsewhere = isolatedSession()
    const removed = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 22, 1)
    const sibling = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 22, 2)
    sibling.event.sender = removed.event.sender
    const window = frameEvent(`chrome-extension://${EXTENSION_ID}/page.html`, sess, 22, 3)
    window.event.sender.id = 78
    const other = frameEvent(`chrome-extension://${EXTENSION_ID}/page.html`, elsewhere.sess, 23, 1)
    await invoke(removed.event, listen)
    const owner = channel()
    await invoke(sibling.event, listen)
    await invoke(window.event, listen)
    await invoke(other.event, listen)
    const worker = contexts.ensureWorkerContext(
      state,
      EXTENSION_ID,
      `chrome-extension://${EXTENSION_ID}/`
    )
    worker.events.add('probe.onPing')
    worker.stream = { send: vi.fn(), close: vi.fn() }
    owner.port1.emit('close')
    host.emitBrowserExtensionEvent({}, 'probe', 'onPing', ['survivors'])
    expect(removed.frame.send).not.toHaveBeenCalled()
    for (const frame of [sibling.frame, window.frame, other.frame]) {
      expect(frame.send).toHaveBeenCalledTimes(1)
    }
    expect(worker.stream.send).toHaveBeenCalledTimes(1)
    expect(worker.stream.close).not.toHaveBeenCalled()
    expect(state.frames.size).toBe(2)
    expect(elsewhere.state.frames.size).toBe(1)
    host.forgetBrowserExtensionContexts(sess)
    host.forgetBrowserExtensionContexts(elsewhere.sess)
  })

  it.each([
    'did-navigate',
    'render-process-gone',
    'destroyed',
    'extension-unloaded',
    'host-forgotten',
    'invalid-frame',
    'failed-send'
  ])('closes a frame port exactly once on %s', async (retirement) => {
    const { sess, state } = isolatedSession()
    const page = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 24, 1)
    await invoke(page.event, listen)
    const owner = channel()
    if (retirement === 'extension-unloaded') {
      contexts.forgetExtensionContexts(sess, EXTENSION_ID)
    } else if (retirement === 'host-forgotten') {
      host.forgetBrowserExtensionContexts(sess)
    } else if (retirement === 'invalid-frame') {
      mocks.frames.delete('24:1')
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', [])
    } else if (retirement === 'failed-send') {
      page.frame.send.mockImplementation(() => {
        throw new Error('Frame retired')
      })
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', [])
    } else {
      page.event.sender.emit(retirement)
    }
    expect(state.frames.size).toBe(0)
    expect(owner.port1.close).toHaveBeenCalledTimes(1)
    expect(owner.port1.listenerCount('close')).toBe(0)
    page.event.sender.emit('destroyed')
    host.forgetBrowserExtensionContexts(sess)
    expect(owner.port1.close).toHaveBeenCalledTimes(1)
  })

  it('releases both endpoints and the registry when frame transfer fails', async () => {
    const { sess, state } = isolatedSession()
    const page = frameEvent(`chrome-extension://${EXTENSION_ID}/frame.html`, sess, 25, 1)
    page.frame.postMessage.mockImplementation(() => {
      throw new Error('Frame retired before transfer')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(invoke(page.event, listen)).resolves.toEqual({
        ok: false,
        error: 'Frame retired before transfer'
      })
      const owner = channel()
      expect(state.frames.size).toBe(0)
      expect(contexts.browserExtensionEventHasListener(sess, 'probe', 'onPing')).toBe(false)
      expect(owner.port1.close).toHaveBeenCalledTimes(1)
      expect(owner.port2.close).toHaveBeenCalledTimes(1)
      expect(owner.port1.listenerCount('close')).toBe(0)
    } finally {
      warning.mockRestore()
      host.forgetBrowserExtensionContexts(sess)
    }
  })

  it.each([1, 10, 100])('visits frame registrations linearly for %s extensions', async (count) => {
    const { sess, state } = isolatedSession()
    const pages: ReturnType<typeof frameEvent>[] = []
    const ids: string[] = []
    try {
      for (let index = 0; index < count; index++) {
        const suffix = index
          .toString(16)
          .padStart(4, '0')
          .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
        const id = `${'c'.repeat(28)}${suffix}`
        ids.push(id)
        extensions.set(id, makeExtension(id, ['probe']))
        const page = frameEvent(`chrome-extension://${id}/page.html`, sess, 40, index + 1)
        await invoke(page.event, listen)
        pages.push(page)
      }
      let visits = 0
      const values = state.frames.values.bind(state.frames)
      const entries = state.frames[Symbol.iterator].bind(state.frames)
      const countRows = <T>(iterator: MapIterator<T>): MapIterator<T> => {
        const next = iterator.next.bind(iterator)
        iterator.next = () => {
          const row = next()
          if (!row.done) {
            visits++
          }
          return row
        }
        return iterator
      }
      vi.spyOn(state.frames, 'values').mockImplementation(() => countRows(values()))
      vi.spyOn(state.frames, Symbol.iterator).mockImplementation(() => countRows(entries()))
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', ['scale'])
      for (const page of pages) {
        expect(page.frame.send).toHaveBeenCalledExactlyOnceWith(BROWSER_EXTENSION_EVENT_CHANNEL, {
          namespace: 'probe',
          event: 'onPing',
          args: ['scale']
        })
      }
      expect(visits).toBeLessThanOrEqual(count * 3)
    } finally {
      host.forgetBrowserExtensionContexts(sess)
      for (const id of ids) {
        extensions.delete(id)
      }
    }
  })

  it('keeps extension membership snapshotted while resolving current frames after callbacks', async () => {
    const { sess } = isolatedSession()
    const first = frameEvent(`chrome-extension://${EXTENSION_ID}/first.html`, sess, 41, 1)
    const previous = frameEvent(`chrome-extension://${OTHER_ID}/old.html`, sess, 41, 2)
    const successor = frameEvent(`chrome-extension://${OTHER_ID}/new.html`, sess, 41, 3)
    const addedId = 'd'.repeat(32)
    const added = frameEvent(`chrome-extension://${addedId}/new.html`, sess, 41, 4)
    extensions.set(OTHER_ID, makeExtension(OTHER_ID, ['probe']))
    extensions.set(addedId, makeExtension(addedId, ['probe']))
    try {
      await invoke(first.event, listen)
      await invoke(previous.event, listen)
      const oldChannel = channel()
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', (extension) => {
        if (extension.id === EXTENSION_ID) {
          oldChannel.port1.emit('close')
          void invoke(successor.event, listen)
          void invoke(added.event, listen)
        }
        return ['current frames']
      })
      expect(first.frame.send).toHaveBeenCalledTimes(1)
      expect(previous.frame.send).not.toHaveBeenCalled()
      expect(successor.frame.send).toHaveBeenCalledTimes(1)
      expect(added.frame.send).not.toHaveBeenCalled()
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', ['next'])
      expect(added.frame.send).toHaveBeenCalledTimes(1)
    } finally {
      host.forgetBrowserExtensionContexts(sess)
      extensions.set(OTHER_ID, makeExtension(OTHER_ID, []))
      extensions.delete(addedId)
    }
  })

  it('delivers to a replacement registered while resolving the same extension arguments', async () => {
    const { sess } = isolatedSession()
    const previous = frameEvent(`chrome-extension://${EXTENSION_ID}/old.html`, sess, 42, 1)
    const successor = frameEvent(`chrome-extension://${EXTENSION_ID}/new.html`, sess, 42, 2)
    await invoke(previous.event, listen)
    const oldChannel = channel()
    try {
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', () => {
        oldChannel.port1.emit('close')
        void invoke(successor.event, listen)
        return ['replacement']
      })
      expect(previous.frame.send).not.toHaveBeenCalled()
      expect(successor.frame.send).toHaveBeenCalledTimes(1)
      expect(oldChannel.port1.close).toHaveBeenCalledTimes(1)
    } finally {
      host.forgetBrowserExtensionContexts(sess)
    }
  })

  it('keeps live frame iteration when a send replaces the final frame registration', async () => {
    const { sess } = isolatedSession()
    const previous = frameEvent(`chrome-extension://${EXTENSION_ID}/old.html`, sess, 43, 1)
    const successor = frameEvent(`chrome-extension://${EXTENSION_ID}/new.html`, sess, 43, 2)
    await invoke(previous.event, listen)
    const oldChannel = channel()
    previous.frame.send.mockImplementation(() => {
      oldChannel.port1.emit('close')
      void invoke(successor.event, listen)
    })
    try {
      host.emitBrowserExtensionEvent({ session: sess }, 'probe', 'onPing', ['replacement'])
      expect(previous.frame.send).toHaveBeenCalledTimes(1)
      expect(successor.frame.send).toHaveBeenCalledTimes(1)
      expect(oldChannel.port1.close).toHaveBeenCalledTimes(1)
    } finally {
      host.forgetBrowserExtensionContexts(sess)
    }
  })
})
