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
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({ browserManager: {} }))
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
mocks.userData = mkdtempSync(join(tmpdir(), 'orca-extension-api-host-'))

const { BROWSER_EXTENSION_INVOKE_CHANNEL } =
  await import('../../../../shared/browser/extensions/browser-extension-channels')
await import('../../../../preload/browser-extension-api-surface')
const registry = await import('./browser-extension-namespace-registry')
const host = await import('./browser-extension-api-host')
const contexts = await import('./browser-extension-contexts')
const { registerBrowserExtensionNamespaces } =
  await import('../register-browser-extension-namespaces')

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
