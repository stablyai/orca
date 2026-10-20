import { beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '' },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  webFrameMain: { fromId: vi.fn() }
}))
vi.mock('../browser-manager', () => ({ browserManager: {} }))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({ waitForTabRegistration: vi.fn() }))
vi.mock('../../runtime/browser/browser-tab-renderer-create', () => ({
  createBrowserTabInRenderer: vi.fn()
}))
vi.mock('../../runtime/browser/browser-tab-renderer-close', () => ({
  closeBrowserTabInRenderer: vi.fn()
}))

const wire = await import('../../../shared/browser-extension-worker-api')
const registry = await import('./browser-extension-namespace-registry')
const host = await import('./browser-extension-api-host')
const { getBrowserExtensionWorkerToken } = await import('./browser-extension-worker-api-host')

const VAULT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const seen: { extensionId: string; fromWorker: boolean | undefined }[] = []

function makeExtension(id: string) {
  return { id, name: id, version: '1', path: '', url: '', manifest: { permissions: ['probe'] } }
}

type ProtocolHandler = (request: Request) => Promise<Response>

function makeSession(ids: string[]) {
  const extensions = new Map(ids.map((id) => [id, makeExtension(id)]))
  const statusListeners: ((details: { versionId: number; runningStatus: string }) => void)[] = []
  const task = { end: vi.fn() }
  const worker = {
    scope: `chrome-extension://${VAULT}/`,
    versionId: 7,
    isDestroyed: () => false,
    startTask: vi.fn(() => task)
  }
  const handlers: ProtocolHandler[] = []
  const stub = {
    handlers,
    worker,
    task,
    startWorkerForScope: vi.fn((_scope: string) => Promise.resolve(worker)),
    stopWorker: () => {
      for (const listener of statusListeners) {
        listener({ versionId: 7, runningStatus: 'stopped' })
      }
    },
    startWorker: () => {
      for (const listener of statusListeners) {
        listener({ versionId: 7, runningStatus: 'running' })
      }
    },
    session: {
      extensions: {
        getExtension: (id: string) => extensions.get(id) ?? null,
        getAllExtensions: () => [...extensions.values()],
        on: vi.fn()
      },
      serviceWorkers: {
        on: (_name: string, listener: (typeof statusListeners)[number]) =>
          statusListeners.push(listener),
        getAllRunning: () => ({}),
        getWorkerFromVersionID: () => worker,
        startWorkerForScope: (scope: string) => stub.startWorkerForScope(scope)
      },
      protocol: {
        handle: (_scheme: string, handler: ProtocolHandler) => {
          handlers.push(handler)
        },
        unhandle: vi.fn()
      }
    }
  }
  return stub
}

const vaultSession = makeSession([VAULT, OTHER])
const otherSession = makeSession([OTHER])

function asSession(stub: ReturnType<typeof makeSession>): Electron.Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host touches only the extensions, serviceWorkers and protocol members stubbed above.
  return stub.session as unknown as Electron.Session
}

function send(stub: ReturnType<typeof makeSession>, request: Request): Promise<Response> {
  const handler = stub.handlers[0]
  if (!handler) {
    throw new Error('protocol not handled')
  }
  return handler(request)
}

function post(stub: ReturnType<typeof makeSession>, url: string, body: unknown): Promise<Response> {
  return send(
    stub,
    new Request(url, { method: 'POST', body: wire.encodeBrowserExtensionWireJson(body) })
  )
}

async function callAs(stub: ReturnType<typeof makeSession>, token: string, request: unknown) {
  const response = await post(stub, wire.BROWSER_EXTENSION_API_CALL_URL, { token, request })
  return wire.decodeBrowserExtensionWireJson(await response.text())
}

function listen(stub: ReturnType<typeof makeSession>, token: string) {
  return callAs(stub, token, { type: 'listen', namespace: 'probe', event: 'onPing', active: true })
}

async function openEvents(stub: ReturnType<typeof makeSession>, token: string) {
  const response = await post(stub, wire.BROWSER_EXTENSION_API_EVENTS_URL, { token })
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('no event stream')
  }
  const decoder = new TextDecoder()
  return {
    next: async () => {
      const { value } = await reader.read()
      return wire.decodeBrowserExtensionWireJson(decoder.decode(value).trim())
    },
    // The worker stopping cancels its fetch.
    cancel: () => reader.cancel()
  }
}

beforeAll(() => {
  registry.registerBrowserExtensionNamespace('probe', {
    permission: 'probe',
    methods: {
      echo: registry.defineBrowserExtensionMethod(
        z.tuple([z.number(), z.number().optional()]),
        (caller, value, extra) => {
          seen.push({ extensionId: caller.extension.id, fromWorker: caller.fromWorker })
          return extra === undefined ? value * 2 : value + extra
        }
      )
    },
    events: ['onPing']
  })
  host.attachBrowserExtensionApiHostToSession(asSession(vaultSession), 'default')
  host.attachBrowserExtensionApiHostToSession(asSession(otherSession), 'work')
})

describe('worker API protocol', () => {
  const echo = { type: 'call', namespace: 'probe', method: 'echo', args: [21, undefined] }

  it('refuses web pages, unknown tokens and extensions not loaded in the session', async () => {
    const response = await post(vaultSession, wire.BROWSER_EXTENSION_API_CALL_URL, {
      request: echo
    })
    expect(response.status).toBe(403)
    expect(
      (
        await post(vaultSession, wire.BROWSER_EXTENSION_API_CALL_URL, {
          token: 'guess',
          request: echo
        })
      ).status
    ).toBe(403)
    // The vault extension is not loaded in the other profile's session.
    expect(
      (
        await post(otherSession, wire.BROWSER_EXTENSION_API_CALL_URL, {
          token: getBrowserExtensionWorkerToken(VAULT),
          request: echo
        })
      ).status
    ).toBe(403)
    expect(
      (await send(vaultSession, new Request(wire.BROWSER_EXTENSION_API_CALL_URL))).status
    ).toBe(405)
    expect(seen).toEqual([])
  })

  it('runs a call as the token’s extension, keeping undefined arguments and the worker alive', async () => {
    vaultSession.startWorker()
    await expect(
      callAs(vaultSession, getBrowserExtensionWorkerToken(VAULT), echo)
    ).resolves.toEqual({
      ok: true,
      value: 42
    })
    await expect(
      callAs(otherSession, getBrowserExtensionWorkerToken(OTHER), echo)
    ).resolves.toEqual({
      ok: true,
      value: 42
    })
    expect(seen).toEqual([
      { extensionId: VAULT, fromWorker: true },
      { extensionId: OTHER, fromWorker: true }
    ])
    expect(vaultSession.worker.startTask).toHaveBeenCalled()
    expect(vaultSession.task.end).toHaveBeenCalled()
  })

  it('streams events, queues them while the worker is stopped, and delivers after restart', async () => {
    const token = getBrowserExtensionWorkerToken(VAULT)
    const first = await openEvents(vaultSession, token)
    await listen(vaultSession, token)
    host.emitBrowserExtensionEvent({ extensionId: VAULT }, 'probe', 'onPing', [1, undefined])
    await expect(first.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: [1, undefined]
    })

    await first.cancel()
    vaultSession.stopWorker()
    host.emitBrowserExtensionEvent({ extensionId: VAULT }, 'probe', 'onPing', [2])
    expect(vaultSession.startWorkerForScope).toHaveBeenCalledWith(`chrome-extension://${VAULT}/`)

    // The restarted worker reopens its stream, then re-registers the listener.
    vaultSession.startWorker()
    const second = await openEvents(vaultSession, token)
    await listen(vaultSession, token)
    await expect(second.next()).resolves.toEqual({ namespace: 'probe', event: 'onPing', args: [2] })
  })

  it('holds a worker-start event until the worker registers its listener, then sends it once', async () => {
    const token = getBrowserExtensionWorkerToken(OTHER)
    const sess = asSession(otherSession)
    host.emitBrowserExtensionWorkerStartEvent(sess, OTHER, 'probe', 'onPing', ['install'])
    expect(otherSession.startWorkerForScope).toHaveBeenCalledWith(`chrome-extension://${OTHER}/`)

    const events = await openEvents(otherSession, token)
    await listen(otherSession, token)
    // A reconnect re-registers the listener; the event must not go out again.
    await listen(otherSession, token)
    host.emitBrowserExtensionEvent({ session: sess, extensionId: OTHER }, 'probe', 'onPing', [
      'later'
    ])
    await expect(events.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['install']
    })
    await expect(events.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['later']
    })
  })
})
