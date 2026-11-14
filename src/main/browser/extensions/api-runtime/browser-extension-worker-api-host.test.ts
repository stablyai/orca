import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '' },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  webContents: { fromId: vi.fn() },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  webFrameMain: { fromId: vi.fn() }
}))
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

const lifecycleStore = vi.hoisted(() => ({
  value: { lastLoaded: { extensionVersion: '1', chromiumVersion: process.versions.chrome } }
}))
vi.mock('../profile-storage/browser-extension-profile-state-store', () => ({
  getBrowserExtensionProfileStateStore: () => ({
    read: () => lifecycleStore.value,
    update: (
      _profile: string,
      _id: string,
      update: (value: typeof lifecycleStore.value) => typeof lifecycleStore.value
    ) => {
      lifecycleStore.value = update(lifecycleStore.value)
    }
  })
}))

const wire = await import('../../../../shared/browser/extensions/browser-extension-worker-api')
const registry = await import('./browser-extension-namespace-registry')
const host = await import('./browser-extension-api-host')
const { beginBrowserExtensionExecution, getBrowserExtensionExecution } =
  await import('./browser-extension-execution-authority')
const tokenFor = (stub: ReturnType<typeof makeSession>, id: string): string =>
  getBrowserExtensionExecution(asSession(stub), id)!.workerToken
const { forgetExtensionContexts, getHostSessionState } =
  await import('./browser-extension-contexts')

const VAULT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const seen: { extensionId: string; fromWorker: boolean | undefined }[] = []

function makeExtension(id: string) {
  return {
    id,
    name: id,
    version: '1',
    path: '',
    url: '',
    manifest: { permissions: ['probe'], background: { service_worker: 'worker.js' } }
  }
}

type ProtocolHandler = (request: Request) => Promise<Response>

function makeSession(ids: string[]) {
  const extensions = new Map(ids.map((id) => [id, makeExtension(id)]))
  const statusListeners: ((details: { versionId: number; runningStatus: string }) => void)[] = []
  const task = { end: vi.fn() }
  const worker = {
    scope: `chrome-extension://${ids[0]}/`,
    versionId: 7,
    isDestroyed: () => false,
    startTask: vi.fn(() => task)
  }
  const handlers: ProtocolHandler[] = []
  const stub = {
    handlers,
    extensions,
    worker,
    task,
    inventory: true,
    startWorkerForScope: vi.fn((_scope: string) => Promise.resolve(worker)),
    stopWorker: () => {
      stub.inventory = false
      for (const listener of statusListeners) {
        listener({ versionId: 7, runningStatus: 'stopped' })
      }
    },
    startWorker: () => {
      stub.inventory = true
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
        removeListener: (_name: string, listener: (typeof statusListeners)[number]) => {
          const index = statusListeners.indexOf(listener)
          if (index !== -1) {
            statusListeners.splice(index, 1)
          }
        },
        getAllRunning: () => (stub.inventory ? { 7: { scope: worker.scope } } : {}),
        getWorkerFromVersionID: () => worker,
        startWorkerForScope: (scope: string) => stub.startWorkerForScope(scope)
      },
      protocol: {
        handle: (_scheme: string, handler: ProtocolHandler) => {
          handlers.push(handler)
        },
        unhandle: vi.fn(),
        isProtocolHandled: () => true
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

// Electron sets initiatorOrigin from the browser's record of who made the request.
function makeRequest(url: string, initiatorOrigin: string | undefined, body: string): Request {
  return Object.assign(new Request(url, { method: 'POST', body }), { initiatorOrigin })
}

function post(
  stub: ReturnType<typeof makeSession>,
  url: string,
  body: unknown,
  initiatorOrigin: string | undefined
): Promise<Response> {
  return send(stub, makeRequest(url, initiatorOrigin, wire.encodeBrowserExtensionWireJson(body)))
}

const originOf = (extensionId: string) => `chrome-extension://${extensionId}`

async function callAs(stub: ReturnType<typeof makeSession>, extensionId: string, request: unknown) {
  const token = tokenFor(stub, extensionId)
  const response = await post(
    stub,
    wire.BROWSER_EXTENSION_API_CALL_URL,
    { token, request, connectionId: 'fixture-connection' },
    originOf(extensionId)
  )
  return wire.decodeBrowserExtensionWireJson(await response.text())
}

function listen(stub: ReturnType<typeof makeSession>, extensionId: string) {
  return callAs(stub, extensionId, {
    type: 'listen',
    namespace: 'probe',
    event: 'onPing',
    active: true
  })
}

async function openEvents(
  stub: ReturnType<typeof makeSession>,
  extensionId: string,
  connectionId = 'fixture-connection'
) {
  const response = await post(
    stub,
    wire.BROWSER_EXTENSION_API_EVENTS_URL,
    { token: tokenFor(stub, extensionId), connectionId },
    originOf(extensionId)
  )
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('no event stream')
  }
  const decoder = new TextDecoder()
  return {
    next: async () => {
      const { value, done } = await reader.read()
      return done ? undefined : wire.decodeBrowserExtensionWireJson(decoder.decode(value).trim())
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
  for (const stub of [vaultSession, otherSession]) {
    for (const id of stub.extensions.keys()) {
      beginBrowserExtensionExecution(asSession(stub), id, new AbortController().signal)
    }
    stub.startWorker()
  }
})

describe('worker API protocol', () => {
  const echo = { type: 'call', namespace: 'probe', method: 'echo', args: [21, undefined] }

  it('releases a stopped worker task and timer without canceling its admitted API work', async () => {
    const stub = makeSession([VAULT])
    const session = asSession(stub)
    host.attachBrowserExtensionApiHostToSession(session, 'held-call')
    beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    stub.startWorker()
    const events = await openEvents(stub, VAULT)
    await listen(stub, VAULT)
    stub.task.end.mockClear()
    let finish = (): void => {}
    let entered = false
    registry.registerBrowserExtensionNamespace('heldCall', {
      permission: 'probe',
      events: [],
      methods: {
        wait: registry.defineBrowserExtensionMethod(
          z.tuple([]),
          () =>
            new Promise<string>((resolve) => {
              entered = true
              finish = () => resolve('completed')
            })
        )
      }
    })
    vi.useFakeTimers()
    const pending = callAs(stub, VAULT, {
      type: 'call',
      namespace: 'heldCall',
      method: 'wait',
      args: []
    })
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(vi.getTimerCount()).toBe(1)
      stub.stopWorker()
      expect(stub.task.end).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      finish()
      await expect(pending).resolves.toEqual({ ok: true, value: 'completed' })
    } finally {
      finish()
      await pending
      await events.cancel()
      host.forgetBrowserExtensionContexts(session)
      vi.useRealTimers()
    }
  })

  it('refuses web pages, wrong tokens and extensions not loaded in the session', async () => {
    const vaultCall = { token: tokenFor(vaultSession, VAULT), request: echo }
    // A website holding the token is refused before main reads its body.
    const fromSite = makeRequest(
      wire.BROWSER_EXTENSION_API_CALL_URL,
      'https://site.example',
      wire.encodeBrowserExtensionWireJson(vaultCall)
    )
    expect((await send(vaultSession, fromSite)).status).toBe(403)
    expect(fromSite.bodyUsed).toBe(false)
    expect(
      (await post(vaultSession, wire.BROWSER_EXTENSION_API_CALL_URL, vaultCall, undefined)).status
    ).toBe(403)
    // Another extension's token does not name the caller.
    expect(
      (
        await post(
          vaultSession,
          wire.BROWSER_EXTENSION_API_CALL_URL,
          { token: tokenFor(vaultSession, OTHER), request: echo },
          originOf(VAULT)
        )
      ).status
    ).toBe(403)
    // The vault extension is not loaded in the other profile's session.
    expect(
      (await post(otherSession, wire.BROWSER_EXTENSION_API_CALL_URL, vaultCall, originOf(VAULT)))
        .status
    ).toBe(403)
    expect(
      (await send(vaultSession, new Request(wire.BROWSER_EXTENSION_API_CALL_URL))).status
    ).toBe(405)
    expect(seen).toEqual([])
  })

  it.each(['extension reload', 'host replacement'] as const)(
    'rejects an old lifetime when its request body finishes after %s',
    async (teardown) => {
      const stub = makeSession([VAULT])
      const session = asSession(stub)
      host.attachBrowserExtensionApiHostToSession(session, 'retired')
      const execution = beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
      let release = (_body: Uint8Array): void => {}
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          release = (bytes) => {
            controller.enqueue(bytes)
            controller.close()
          }
        }
      })
      const options = { method: 'POST', body, duplex: 'half' }
      const request = Object.assign(new Request(wire.BROWSER_EXTENSION_API_CALL_URL, options), {
        initiatorOrigin: originOf(VAULT)
      })
      const before = seen.length
      const pending = send(stub, request)
      if (teardown === 'extension reload') {
        forgetExtensionContexts(session, VAULT)
        stub.extensions.set(VAULT, makeExtension(VAULT))
      } else {
        host.forgetBrowserExtensionContexts(session)
        host.attachBrowserExtensionApiHostToSession(session, 'replacement')
      }
      release(
        new TextEncoder().encode(
          wire.encodeBrowserExtensionWireJson({
            token: execution.workerToken,
            request: echo
          })
        )
      )
      expect((await pending).status).toBe(403)
      expect(seen).toHaveLength(before)
      expect(getHostSessionState(session)?.workers.has(VAULT)).toBe(false)
      host.forgetBrowserExtensionContexts(session)
    }
  )

  it('streams events, queues them while the worker is stopped, and delivers after restart', async () => {
    const first = await openEvents(vaultSession, VAULT)
    await listen(vaultSession, VAULT)
    host.emitBrowserExtensionEvent({ extensionId: VAULT }, 'probe', 'onPing', [1, undefined])
    await expect(first.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: [1, undefined]
    })

    await first.cancel()
    vaultSession.stopWorker()
    host.emitBrowserExtensionEvent({ extensionId: VAULT }, 'probe', 'onPing', [2])

    // The restarted worker reopens its stream, then re-registers the listener.
    vaultSession.startWorker()
    const second = await openEvents(vaultSession, VAULT)
    await listen(vaultSession, VAULT)
    await expect(second.next()).resolves.toEqual({ namespace: 'probe', event: 'onPing', args: [2] })
  })

  it('holds a worker-start event until the worker registers its listener, then sends it once', async () => {
    const sess = asSession(otherSession)
    host.emitBrowserExtensionWorkerStartEvent(sess, OTHER, 'probe', 'onPing', ['install'])

    const events = await openEvents(otherSession, OTHER)
    await listen(otherSession, OTHER)
    // A reconnect re-registers the listener; the event must not go out again.
    await listen(otherSession, OTHER)
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

  it('admits first events before publication and flushes only the current matching filters once', async () => {
    const stub = makeSession([VAULT])
    const session = asSession(stub)
    host.attachBrowserExtensionApiHostToSession(session, 'first-event')
    beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    stub.startWorker()
    host.emitBrowserExtensionEvent(
      { session },
      'probe',
      'onPing',
      ['ignored'],
      (filter) => filter === 'ignored'
    )
    host.emitBrowserExtensionEvent(
      { session },
      'probe',
      'onPing',
      ['first'],
      (filter) => filter === 'first'
    )
    const events = await openEvents(stub, VAULT)
    await callAs(stub, VAULT, {
      type: 'listen',
      namespace: 'probe',
      event: 'onPing',
      active: true,
      filters: ['first']
    })
    await callAs(stub, VAULT, { type: 'published' })
    host.emitBrowserExtensionEvent(
      { session },
      'probe',
      'onPing',
      ['later'],
      (filter) => filter === 'first'
    )
    await expect(events.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['first']
    })
    await expect(events.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['later']
    })
    await events.cancel()
    host.forgetBrowserExtensionContexts(session)
  })

  it('rejects a predecessor connection listen after reconnect without removing the current listener', async () => {
    const stub = makeSession([VAULT])
    const session = asSession(stub)
    host.attachBrowserExtensionApiHostToSession(session, 'reconnect')
    beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    stub.startWorker()
    const previous = await openEvents(stub, VAULT, 'previous')
    const current = await openEvents(stub, VAULT)
    await listen(stub, VAULT)
    const response = await post(
      stub,
      wire.BROWSER_EXTENSION_API_CALL_URL,
      {
        token: tokenFor(stub, VAULT),
        connectionId: 'previous',
        request: { type: 'listen', namespace: 'probe', event: 'onPing', active: false }
      },
      originOf(VAULT)
    )
    expect(response.status).toBe(409)
    host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['current'])
    await expect(current.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['current']
    })
    await expect(previous.next()).resolves.toBeUndefined()
    await current.cancel()
    host.forgetBrowserExtensionContexts(session)
  })

  it('wakes retained subscriptions after suspension without delivering into the old connection', async () => {
    const stub = makeSession([VAULT])
    const session = asSession(stub)
    host.attachBrowserExtensionApiHostToSession(session, 'suspended')
    const old = beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    stub.startWorker()
    const first = await openEvents(stub, VAULT)
    await listen(stub, VAULT)
    await callAs(stub, VAULT, { type: 'published' })
    old.controller.abort()
    forgetExtensionContexts(session, VAULT, true)
    beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['reopen'])
    stub.startWorker()
    const second = await openEvents(stub, VAULT)
    await listen(stub, VAULT)
    await expect(second.next()).resolves.toEqual({
      namespace: 'probe',
      event: 'onPing',
      args: ['reopen']
    })
    await expect(first.next()).resolves.toBeUndefined()
    await second.cancel()
    host.forgetBrowserExtensionContexts(session)
  })
})

afterEach(() => vi.useRealTimers())

it('keeps a cold alarm queued when native success precedes running publication and stop races it', async () => {
  const stub = makeSession([VAULT])
  const session = asSession(stub)
  host.attachBrowserExtensionApiHostToSession(session, 'cold-start')
  const execution = beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
  stub.startWorker()
  const first = await openEvents(stub, VAULT)
  await listen(stub, VAULT)
  await callAs(stub, VAULT, { type: 'published' })
  stub.stopWorker()
  host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['alarm'])
  const starting = host.startBrowserExtensionWorker(
    execution,
    getHostSessionState(session)!.workers.get(VAULT)!
  )
  const result = starting.then(
    (worker) => ({ worker }),
    (error: unknown) => ({ error })
  )
  // Let the scope-success continuation run before the later native observer task.
  await new Promise<void>((resolve) => setImmediate(resolve))
  stub.startWorker()
  await expect(result).resolves.toEqual({ worker: stub.worker })
  const second = await openEvents(stub, VAULT)
  await listen(stub, VAULT)
  await expect(second.next()).resolves.toEqual({
    namespace: 'probe',
    event: 'onPing',
    args: ['alarm']
  })
  await expect(first.next()).resolves.toBeUndefined()
  await second.cancel()
  host.forgetBrowserExtensionContexts(session)
})

it('cancels a scope start that never settles without delaying execution retirement', async () => {
  const stub = makeSession([VAULT])
  const session = asSession(stub)
  host.attachBrowserExtensionApiHostToSession(session, 'cancel-start')
  const execution = beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
  stub.startWorker()
  stub.startWorkerForScope.mockImplementationOnce(() => new Promise(() => {}))
  const started = host.startBrowserExtensionWorker(
    execution,
    getHostSessionState(session)!.workers.get(VAULT)!
  )
  const rejected = expect(started).rejects.toThrow('unloaded')
  execution.controller.abort()
  await rejected
  host.forgetBrowserExtensionContexts(session)
})

it('keeps lifecycle delivery ahead of provisional request noise, and never replays it after checkpoint', async () => {
  const stub = makeSession([VAULT])
  const session = asSession(stub)
  host.attachBrowserExtensionApiHostToSession(session, 'lifecycle')
  beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
  stub.startWorker()
  registry.registerBrowserExtensionNamespace('runtime', { methods: {}, events: ['onStartup'] })
  host.emitBrowserExtensionWorkerStartEvent(session, VAULT, 'runtime', 'onStartup', [])
  for (let index = 0; index < 150; index++) {
    host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', [index])
  }
  const events = await openEvents(stub, VAULT)
  await callAs(stub, VAULT, {
    type: 'listen',
    namespace: 'runtime',
    event: 'onStartup',
    active: true
  })
  await callAs(stub, VAULT, { type: 'published' })
  await expect(events.next()).resolves.toEqual({
    namespace: 'runtime',
    event: 'onStartup',
    args: []
  })
  forgetExtensionContexts(session, VAULT, true)
  await expect(events.next()).resolves.toBeUndefined()
  host.forgetBrowserExtensionContexts(session)
})

it.each([10, 100])('never repeats irrelevant lifecycle wakes across %i reopens', async (count) => {
  const { fireRuntimeLifecycleEvents } =
    await import('../profile-sessions/browser-extension-runtime-lifecycle')
  for (const end of ['suspend', 'failure', 'published'] as const) {
    const stub = makeSession([VAULT])
    const session = asSession(stub)
    host.attachBrowserExtensionApiHostToSession(session, `lifecycle-${end}`)
    const execution = beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
    stub.startWorker()
    fireRuntimeLifecycleEvents(session, 'profile', stub.extensions.get(VAULT)!, 'startup')
    const context = getHostSessionState(session)!.workers.get(VAULT)!
    if (end === 'failure') {
      stub.startWorkerForScope.mockRejectedValue(new Error('native failure'))
      await expect(host.startBrowserExtensionWorker(execution, context)).rejects.toThrow(
        'native failure'
      )
    } else if (end === 'published') {
      const events = await openEvents(stub, VAULT)
      await callAs(stub, VAULT, { type: 'published' })
      await events.cancel()
    }
    // Complete the admitted start attempt before measuring subsequent reopen work.
    await Promise.resolve()
    await Promise.resolve()
    const before = stub.startWorkerForScope.mock.calls.length
    for (let index = 0; index < count; index++) {
      forgetExtensionContexts(session, VAULT, true)
      execution.controller.abort()
      beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
      fireRuntimeLifecycleEvents(session, 'profile', stub.extensions.get(VAULT)!, 'other')
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(stub.startWorkerForScope.mock.calls.length - before).toBe(end === 'suspend' ? 1 : 0)
    host.forgetBrowserExtensionContexts(session)
  }
})

it('does not admit unknown events after fallback or renew the original window on failed reconnect', async () => {
  vi.useFakeTimers()
  const { beginWorkerPublication } = await import('./browser-extension-worker-event-stream')
  const stub = makeSession([VAULT])
  const session = asSession(stub)
  host.attachBrowserExtensionApiHostToSession(session, 'fallback')
  beginBrowserExtensionExecution(session, VAULT, new AbortController().signal)
  stub.startWorker()
  const context = getHostSessionState(session)!.workers.get(VAULT)!
  const first = await openEvents(stub, VAULT)
  await vi.advanceTimersByTimeAsync(10_000)
  context.initialPublication = false
  await first.cancel()
  const second = await openEvents(stub, VAULT)
  host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['closed'])
  await second.cancel()
  // A genuine new native run gets a new admission window.
  beginWorkerPublication(context, true)
  const third = await openEvents(stub, VAULT)
  await vi.advanceTimersByTimeAsync(29_000)
  await third.cancel()
  const fourth = await openEvents(stub, VAULT)
  await vi.advanceTimersByTimeAsync(2_000)
  host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['expired'])
  await listen(stub, VAULT)
  host.emitBrowserExtensionEvent({ session }, 'probe', 'onPing', ['real'])
  await expect(fourth.next()).resolves.toEqual({
    namespace: 'probe',
    event: 'onPing',
    args: ['real']
  })
  await fourth.cancel()
  host.forgetBrowserExtensionContexts(session)
})
