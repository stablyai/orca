import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'

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
vi.mock('../api-runtime/browser-extension-api-host', () => ({
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

const { registerNativeMessagingNamespace } = await import('../api/native-messaging')
const registry = await import('../api-runtime/browser-extension-namespace-registry')
const contexts = await import('../api-runtime/browser-extension-contexts')
await import('../api-runtime/browser-extension-api-request')

const VAULT = 'v'.repeat(32)
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
  it('starts no host when its extension unloads during the host lookup', async () => {
    const { session, emitter } = fakeSession()
    const { caller } = workerCaller(session)
    let finishLookup: (value: unknown) => void = () => {}
    mocks.lookup.mockReturnValueOnce(new Promise((resolve) => (finishLookup = resolve)))
    const connecting = call(caller, 'connect', 'late', 'com.example.vault')
    await vi.waitFor(() => expect(mocks.lookup).toHaveBeenCalled())
    emitter.extensions.emit('extension-unloaded', {}, { id: VAULT })
    finishLookup({ ok: true, program: '/opt/vault/host', manifestPath: '/m.json' })
    await expect(connecting).rejects.toThrow('The port owner went away')
    expect(mocks.hosts).toEqual([])
  })
})
