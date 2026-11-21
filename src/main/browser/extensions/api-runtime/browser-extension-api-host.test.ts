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
await import('../../../../preload/browser/extensions/api/browser-extension-api-surface')
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
  protocol: { handle: vi.fn(), unhandle: vi.fn(), isProtocolHandled: vi.fn(() => true) }
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

it('forgets the extension protocol twice without Electron refusing the second unhandle', () => {
  const handled = new Set<string>()
  const unhandle = vi.fn((scheme: string) => {
    if (!handled.delete(scheme)) {
      throw new Error(`Failed to unhandle protocol: ${scheme}`)
    }
  })
  const sess = {
    ...extensionSession,
    protocol: {
      handle: (scheme: string) => {
        handled.add(scheme)
      },
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this session copies the host's stub and replaces only protocol, which the retirement path calls.
  const session = sess as unknown as Electron.Session
  host.attachBrowserExtensionApiHostToSession(session, 'deleted-profile')
  host.forgetBrowserExtensionContexts(session)
  expect(() => host.forgetBrowserExtensionContexts(session)).not.toThrow()
  expect(unhandle).toHaveBeenCalledTimes(1)
  expect(unhandle).toHaveBeenCalledWith('orca-extension-api')
})
