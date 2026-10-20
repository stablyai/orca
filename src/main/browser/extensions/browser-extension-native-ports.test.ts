import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from './browser-extension-namespace-registry'

type FakeHost = {
  launch: { name: string; program: string; args: string[] }
  handlers: { onMessage: (json: string) => void; onClose: (error: string) => void }
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const hosts: FakeHost[] = []
  return { hosts, lookup: vi.fn(), workerEvents: vi.fn(), frames: new Map<string, unknown>() }
})

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '/user-data' },
  BrowserWindow: { fromWebContents: () => null },
  webFrameMain: {
    fromId: (processId: number, routingId: number) => mocks.frames.get(`${processId}:${routingId}`)
  }
}))
vi.mock('./browser-extension-api-host', () => ({
  emitBrowserExtensionWorkerStartEvent: mocks.workerEvents
}))
vi.mock('./browser-extension-native-host-lookup', () => ({
  resolveNativeMessagingHost: mocks.lookup,
  defaultNativeHostLookupDeps: () => ({}),
  nativeHostOriginArgument: (id: string) => `chrome-extension://${id}/`
}))
vi.mock('./browser-extension-native-host-process', () => ({
  killAllNativeHosts: vi.fn(),
  startNativeHost: async (launch: FakeHost['launch'], handlers: FakeHost['handlers']) => {
    const host: FakeHost = { launch, handlers, send: vi.fn(), close: vi.fn() }
    mocks.hosts.push(host)
    return { send: host.send, close: host.close }
  }
}))

const { registerNativeMessagingNamespace } = await import('./api/native-messaging')
const registry = await import('./browser-extension-namespace-registry')
const contexts = await import('./browser-extension-contexts')
const { handleBrowserExtensionApiRequest } = await import('./browser-extension-api-request')

const VAULT = 'v'.repeat(32)
const PLAIN = 'p'.repeat(32)
registerNativeMessagingNamespace()
const methods = registry.getBrowserExtensionNamespace('orcaNativeMessaging')?.methods ?? {}

function fakeSession() {
  const emitter = { extensions: new EventEmitter(), serviceWorkers: new EventEmitter() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the port registry only subscribes to these two emitters.
  return { emitter, session: emitter as unknown as Electron.Session }
}

function extension(id: string, permissions: string[]) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callers read id and manifest only.
  return { id, manifest: { permissions } } as unknown as Electron.Extension
}

function frameCaller(
  sess: Electron.Session,
  contents: EventEmitter & { id: number },
  routingId: number
) {
  const frame = {
    processId: 7,
    routingId,
    url: `chrome-extension://${VAULT}/popup.html`,
    isDestroyed: () => false,
    send: vi.fn()
  }
  mocks.frames.set(`7:${routingId}`, frame)
  const caller: BrowserExtensionCaller = {
    extension: extension(VAULT, ['nativeMessaging']),
    session: sess,
    browserProfileId: 'default',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ports read id and subscribe to lifecycle events.
    webContents: contents as unknown as Electron.WebContents,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ports read ids, url, isDestroyed and send.
    frame: frame as unknown as Electron.WebFrameMain
  }
  return { caller, frame }
}

function workerCaller(sess: Electron.Session, versionId = 3) {
  const end = vi.fn()
  const state = contexts.ensureHostSessionState(sess, 'default')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ports read versionId, isDestroyed and startTask.
  contexts.ensureWorkerContext(state, VAULT, `chrome-extension://${VAULT}/`).running = {
    versionId,
    isDestroyed: () => false,
    startTask: () => ({ end })
  } as unknown as Electron.ServiceWorkerMain
  const caller: BrowserExtensionCaller = {
    extension: extension(VAULT, ['nativeMessaging']),
    session: sess,
    browserProfileId: 'default',
    fromWorker: true
  }
  return { caller, end, state }
}

const call = (caller: BrowserExtensionCaller, method: string, ...args: unknown[]) =>
  methods[method].invoke(caller, args)

beforeEach(() => {
  mocks.hosts.length = 0
  mocks.workerEvents.mockReset()
  mocks.lookup.mockReset()
  mocks.lookup.mockResolvedValue({ ok: true, program: '/opt/vault/host', manifestPath: '/m.json' })
})

describe('native messaging ports', () => {
  it('needs the nativeMessaging permission', async () => {
    const { session } = fakeSession()
    const caller = { ...workerCaller(session).caller, extension: extension(PLAIN, ['storage']) }
    const result = await handleBrowserExtensionApiRequest(
      caller,
      contexts.ensureHostSessionState(session, 'default'),
      { type: 'call', namespace: 'orcaNativeMessaging', method: 'connect', args: ['p1', 'com.x'] },
      {
        kind: 'worker',
        context: contexts.ensureWorkerContext(
          contexts.ensureHostSessionState(session, 'default'),
          PLAIN,
          ''
        )
      }
    )
    expect(result).toEqual({
      ok: false,
      error: 'This API requires the "nativeMessaging" permission'
    })
    expect(mocks.hosts).toEqual([])
  })

  it('reports lookup failures with Chrome’s messages and starts nothing', async () => {
    const { session } = fakeSession()
    const { caller } = workerCaller(session)
    mocks.lookup.mockResolvedValueOnce({
      ok: false,
      error: 'Access to the specified native messaging host is forbidden.'
    })
    await expect(call(caller, 'connect', 'p1', 'com.x')).rejects.toThrow(
      'Access to the specified native messaging host is forbidden.'
    )
    expect(mocks.hosts).toEqual([])
  })

  it('routes a worker port to that worker, keeps it alive while open, and kills the host on disconnect', async () => {
    const { session } = fakeSession()
    const { caller, end } = workerCaller(session)
    await call(caller, 'connect', 'p1', 'com.example.vault')
    const [host] = mocks.hosts
    expect(host.launch).toMatchObject({
      program: '/opt/vault/host',
      args: [`chrome-extension://${VAULT}/`]
    })
    await call(caller, 'postMessage', 'p1', '{"a":1}')
    expect(host.send).toHaveBeenCalledWith('{"a":1}')
    host.handlers.onMessage('{"b":2}')
    expect(mocks.workerEvents).toHaveBeenCalledWith(
      session,
      VAULT,
      'orcaNativeMessaging',
      'onPortEvent',
      ['p1', 'message', '{"b":2}']
    )
    expect(end).not.toHaveBeenCalled()
    await call(caller, 'disconnect', 'p1')
    expect(host.close).toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('tells the page frame when the host exits, and only that frame', async () => {
    const { session } = fakeSession()
    const contents = Object.assign(new EventEmitter(), { id: 11 })
    const first = frameCaller(session, contents, 1)
    const second = frameCaller(session, contents, 2)
    await call(first.caller, 'connect', 'same-id', 'com.example.vault')
    await call(second.caller, 'connect', 'same-id', 'com.example.vault')
    // A context reaches only its own port, even with the same id.
    await call(second.caller, 'postMessage', 'same-id', '1')
    expect(mocks.hosts[0].send).not.toHaveBeenCalled()
    mocks.hosts[0].handlers.onClose('Native host has exited.')
    expect(first.frame.send).toHaveBeenCalledWith('browserExtension:event', {
      namespace: 'orcaNativeMessaging',
      event: 'onPortEvent',
      args: ['same-id', 'disconnect', 'Native host has exited.']
    })
    expect(second.frame.send).not.toHaveBeenCalled()
  })

  it('kills a page’s hosts when its frame navigates or its contents are destroyed', async () => {
    const { session } = fakeSession()
    const contents = Object.assign(new EventEmitter(), { id: 12 })
    const page = frameCaller(session, contents, 1)
    const sibling = frameCaller(session, contents, 2)
    await call(page.caller, 'connect', 'a', 'com.example.vault')
    await call(sibling.caller, 'connect', 'b', 'com.example.vault')
    contents.emit('did-frame-navigate', {}, 'chrome-extension://x/', 200, 'OK', false, 7, 1)
    expect(mocks.hosts[0].close).toHaveBeenCalled()
    expect(mocks.hosts[1].close).not.toHaveBeenCalled()
    contents.emit('destroyed')
    expect(mocks.hosts[1].close).toHaveBeenCalled()
    expect(page.frame.send).not.toHaveBeenCalled()
  })

  it('kills the hosts of a stopped worker and of an unloaded (disabled, removed) extension', async () => {
    const { session, emitter } = fakeSession()
    const { caller, end } = workerCaller(session, 5)
    await call(caller, 'connect', 'w', 'com.example.vault')
    emitter.serviceWorkers.emit('running-status-changed', {
      versionId: 4,
      runningStatus: 'stopped'
    })
    expect(mocks.hosts[0].close).not.toHaveBeenCalled()
    emitter.serviceWorkers.emit('running-status-changed', {
      versionId: 5,
      runningStatus: 'stopped'
    })
    expect(mocks.hosts[0].close).toHaveBeenCalled()
    expect(end).toHaveBeenCalled()

    const page = frameCaller(session, Object.assign(new EventEmitter(), { id: 13 }), 1)
    await call(page.caller, 'connect', 'p', 'com.example.vault')
    emitter.extensions.emit('extension-unloaded', {}, { id: VAULT })
    expect(mocks.hosts[1].close).toHaveBeenCalled()
    expect(mocks.workerEvents).not.toHaveBeenCalled()
  })

  it('sends one message, returns the first reply and closes the host', async () => {
    const { session } = fakeSession()
    const { caller } = workerCaller(session)
    const reply = call(caller, 'sendNativeMessage', 'com.example.vault', '{"q":1}')
    await vi.waitFor(() => expect(mocks.hosts[0]?.send).toHaveBeenCalledWith('{"q":1}'))
    mocks.hosts[0].handlers.onMessage('{"r":1}')
    await expect(reply).resolves.toBe('{"r":1}')
    expect(mocks.hosts[0].close).toHaveBeenCalled()
  })

  it('rejects a one-shot message when the host exits without replying or its owner goes away', async () => {
    const { session, emitter } = fakeSession()
    const { caller } = workerCaller(session, 8)
    const exited = call(caller, 'sendNativeMessage', 'com.example.vault', '1')
    await vi.waitFor(() => expect(mocks.hosts).toHaveLength(1))
    mocks.hosts[0].handlers.onClose('Native host has exited.')
    await expect(exited).rejects.toThrow('Native host has exited.')

    const orphaned = call(caller, 'sendNativeMessage', 'com.example.vault', '1')
    await vi.waitFor(() => expect(mocks.hosts).toHaveLength(2))
    emitter.serviceWorkers.emit('running-status-changed', {
      versionId: 8,
      runningStatus: 'stopped'
    })
    await expect(orphaned).rejects.toThrow()
    expect(mocks.hosts[1].close).toHaveBeenCalled()
  })
})
