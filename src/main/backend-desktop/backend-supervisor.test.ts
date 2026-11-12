import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_DELIVERY,
  BACKEND_PORT_REQUEST
} from '../../shared/backend-service-contract'
const rig = vi.hoisted(() => ({
  fork: vi.fn(),
  handle: vi.fn(),
  call: vi.fn(),
  appOn: vi.fn(),
  appOff: vi.fn()
}))
vi.mock('electron', () => ({
  app: { on: rig.appOn, off: rig.appOff },
  BrowserWindow: { fromWebContents: () => ({}) },
  ipcMain: { handle: rig.handle, removeHandler: vi.fn() },
  utilityProcess: { fork: rig.fork },
  MessageChannelMain: class {
    port1 = {}
    port2 = {}
  }
}))
vi.mock('./backend-bootstrap', () => ({ capturedBootstrap: {} }))
vi.mock('../../shared/backend-port-rpc', () => ({
  BackendPortRpc: class {
    call = rig.call
    close() {}
  }
}))
vi.mock('../backend/backend-message-port', () => ({ backendMessagePort: () => ({}) }))
vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('../worker-threads/worker-thread-entry-path', () => ({
  currentWorkerEntryLayout: () => ({ moduleDir: '/' }),
  resolveWorkerThreadEntryPath: () => 'backend-entry.js'
}))
vi.mock('../window/renderer-document-navigation', () => ({
  isRendererDocumentNavigation: () => true
}))
vi.mock('../usage/worktree-attribution/usage-worktree-metadata', () => ({
  loadKnownUsageWorktreesByRepo: vi.fn()
}))
vi.mock('../claude-usage/transcript-file-discovery', () => ({
  claudeProfileTranscriptDirs: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ isTelemetryEnabled: vi.fn(), track: vi.fn() }))
import { BackendSupervisor } from './backend-supervisor'
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('keeps ready-generated recovery behind owner backoff and the cap, then admits real demand', async () => {
  vi.useFakeTimers()
  const children: (EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  })[] = []
  rig.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    children.push(child)
    return child
  })
  const supervisor = new BackendSupervisor({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getRememberedWorktreeDisplayNames: () => new Map(),
    whenLoaded: async () => {}
  })
  const frame = { postMessage: vi.fn() }
  const sender = Object.assign(new EventEmitter(), {
    id: 2,
    mainFrame: frame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html'
  })
  const request = rig.handle.mock.calls.find(([channel]) => channel === BACKEND_PORT_REQUEST)?.[1]
  const event = { sender, senderFrame: frame }
  const token = '11111111-1111-1111-1111-111111111111'
  const joined = request(event, token, 'recovery')
  children[0].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await joined
  for (let i = 0; i < 3; i++) {
    children[i].emit('exit', 1)
    await expect(request(event, token, 'recovery')).rejects.toThrow('Usage is unavailable')
    expect(children).toHaveLength(i + 1)
    if (i < 2) {
      const delay = i === 0 ? 500 : 1000
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(children).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(children).toHaveLength(i + 2)
      const recovery = request(event, token, 'recovery')
      children[i + 1].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
      await recovery
    }
  }
  await vi.advanceTimersByTimeAsync(5000)
  expect(children).toHaveLength(3)
  expect(frame.postMessage).toHaveBeenCalledWith(BACKEND_CONNECTION_CHANGED, {
    connected: false,
    unavailable: true
  })
  await expect(request(event, token, 'invalid')).rejects.toThrow(
    'Invalid backend connection request'
  )
  const demand = request(event, token)
  expect(children).toHaveLength(4)
  children[3].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await demand
  children[3].emit('exit', 1)
  rig.call.mockResolvedValueOnce({ inputTokens: 42 })
  const automation = supervisor.automationClient('claudeUsage').getAutomationRunUsage({
    worktreeId: null,
    terminalSessionId: null,
    startedAt: null,
    completedAt: null
  })
  expect(children).toHaveLength(5)
  children[4].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await expect(automation).resolves.toEqual({ inputTokens: 42 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(children).toHaveLength(5)
  children[4].emit('exit', 1)
  await vi.advanceTimersByTimeAsync(499)
  expect(children).toHaveLength(5)
  await vi.advanceTimersByTimeAsync(1)
  expect(children).toHaveLength(6)
  children[5].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  const stopped = supervisor.stop()
  children[5].emit('exit', 0)
  await stopped
})
it('publishes terminal unavailability on the third death and preserves explicit recovery', async () => {
  vi.useFakeTimers()
  const children: (EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  })[] = []
  rig.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
    children.push(child)
    return child
  })
  const supervisor = new BackendSupervisor({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getRememberedWorktreeDisplayNames: () => new Map(),
    whenLoaded: async () => {}
  })
  const frame = { postMessage: vi.fn() }
  const sender = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: frame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html'
  })
  const request = rig.handle.mock.calls.find(([channel]) => channel === BACKEND_PORT_REQUEST)?.[1]
  const initial = request({ sender, senderFrame: frame }, '11111111-1111-1111-1111-111111111111')
  children[0].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await initial
  for (let i = 0; i < 3; i++) {
    children[i].emit('exit', 1)
    expect(frame.postMessage).toHaveBeenLastCalledWith(BACKEND_CONNECTION_CHANGED, {
      connected: false,
      unavailable: i === 2
    })
    await vi.advanceTimersByTimeAsync(2000)
    if (i < 2) {
      children[i + 1].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
    }
  }
  expect(children).toHaveLength(3)
  const retry = request({ sender, senderFrame: frame }, '22222222-2222-2222-2222-222222222222')
  children[3].emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await retry
  expect(frame.postMessage).toHaveBeenCalledWith(BACKEND_CONNECTION_CHANGED, {
    connected: true,
    unavailable: false
  })
  const stopped = supervisor.stop()
  children[3].emit('exit', 0)
  await stopped
})

it('retires only the exited renderer document and rejects its pending port delivery', async () => {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })
  rig.fork.mockReturnValue(child)
  const supervisor = new BackendSupervisor({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getRememberedWorktreeDisplayNames: () => new Map(),
    whenLoaded: async () => {}
  })
  const frame = { postMessage: vi.fn() }
  const sender = Object.assign(new EventEmitter(), {
    id: 3,
    mainFrame: frame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html'
  })
  const request = rig.handle.mock.calls.find(([channel]) => channel === BACKEND_PORT_REQUEST)?.[1]
  const gone = rig.appOn.mock.calls.find(([event]) => event === 'render-process-gone')?.[1]
  const token = '33333333-3333-3333-3333-333333333333'
  const initial = request({ sender, senderFrame: frame }, token)
  const rejected = expect(initial).rejects.toThrow('The document was replaced')
  gone({}, { id: 99 })
  expect(child.postMessage).not.toHaveBeenCalledWith({ type: 'retire', token })
  gone({}, sender)
  expect(child.postMessage).toHaveBeenCalledWith({ type: 'retire', token })
  child.emit('message', { type: 'ready', protocol: 1, capabilities: ['usage'] })
  await rejected
  expect(frame.postMessage.mock.calls.some(([channel]) => channel === BACKEND_PORT_DELIVERY)).toBe(
    false
  )
  await request({ sender, senderFrame: frame }, token)
  expect(
    child.postMessage.mock.calls.filter(([message]) => message.type === 'client')
  ).toHaveLength(1)
  gone({}, sender)
  expect(
    child.postMessage.mock.calls.filter(([message]) => message.type === 'retire')
  ).toHaveLength(2)
  const stopped = supervisor.stop()
  expect(rig.appOff).toHaveBeenCalledWith('render-process-gone', gone)
  child.emit('exit', 0)
  await stopped
})

function startupFixture() {
  const children: (EventEmitter & {
    postMessage: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  })[] = []
  rig.fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(() => false)
    })
    children.push(child)
    return child
  })
  const supervisor = new BackendSupervisor({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getRememberedWorktreeDisplayNames: () => new Map(),
    whenLoaded: async () => {}
  })
  const frame = { postMessage: vi.fn() }
  const sender = Object.assign(new EventEmitter(), {
    id: 4,
    mainFrame: frame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html'
  })
  const request = rig.handle.mock.calls.find(([channel]) => channel === BACKEND_PORT_REQUEST)?.[1]
  const token = '44444444-4444-4444-4444-444444444444'
  const read = () =>
    supervisor.automationClient('claudeUsage').getAutomationRunUsage({
      worktreeId: null,
      terminalSessionId: null,
      startedAt: null,
      completedAt: null
    })
  return {
    children,
    supervisor,
    frame,
    read,
    request: (purpose = 'demand', contents = sender, requestToken = token) =>
      request({ sender: contents, senderFrame: contents.mainFrame }, requestToken, purpose)
  }
}

it('retries a rejected signal-free launch on new demand without replay or false retirement', async () => {
  vi.useFakeTimers()
  const { children, supervisor, frame, read, request } = startupFixture()
  const ready = { type: 'ready', protocol: 1, capabilities: ['usage'] }
  for (let attempt = 0; attempt < 4; attempt++) {
    const demand = expect(read()).rejects.toThrow('Usage is still unavailable')
    const joined = expect(request('recovery')).rejects.toThrow('Usage is still unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    await demand
    await joined
    children[attempt].emit('message', ready)
    expect(frame.postMessage).not.toHaveBeenCalledWith(BACKEND_CONNECTION_CHANGED, {
      connected: true,
      unavailable: false
    })
    await expect(request('recovery')).rejects.toThrow('Usage is still unavailable')
    expect(children).toHaveLength(attempt + 1)
    expect(rig.call).not.toHaveBeenCalled()
  }
  const retry = read()
  const port = request()
  children[4].emit('message', ready)
  rig.call.mockResolvedValueOnce({ inputTokens: 42 })
  await expect(retry).resolves.toEqual({ inputTokens: 42 })
  await port
  expect(rig.call).toHaveBeenCalledTimes(1)
  const notifications = frame.postMessage.mock.calls.slice()
  for (const child of children.slice(0, 4)) {
    child.kill.mockClear()
    child.emit('spawn')
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('message', ready)
    child.emit('exit', 1)
  }
  expect(frame.postMessage.mock.calls).toEqual(notifications)
  const { recordDurableCrashBreadcrumb } =
    await import('../crash-reporting/breadcrumbs/durable-crash-breadcrumb')
  expect(recordDurableCrashBreadcrumb).toHaveBeenLastCalledWith('backend_process_exited', {
    pid: null,
    incarnation: null,
    exitCode: 1,
    expected: true
  })
  // A rejection after successful readiness cannot turn that owner into a failed startup.
  children[4].emit('error', new Error('late error'))
  rig.call.mockResolvedValueOnce({ inputTokens: 43 })
  await expect(read()).resolves.toEqual({ inputTokens: 43 })
  expect(children).toHaveLength(5)
  const stopped = supervisor.stop()
  let quit = false
  void stopped.then(() => {
    quit = true
  })
  await Promise.resolve()
  expect(quit).toBe(false)
  children[4].emit('exit', 0)
  await stopped
  await expect(read()).rejects.toThrow('Orca is shutting down')
  expect(children).toHaveLength(5)
})

it('rejects old requests when ownership changes across readiness instead of rerouting them', async () => {
  const { children, supervisor, frame, read, request } = startupFixture()
  const ready = { type: 'ready', protocol: 1, capabilities: ['usage'] }
  children[0].emit('message', ready)
  const oldRead = expect(read()).rejects.toThrow('Usage disconnected')
  const oldPort = expect(request()).rejects.toThrow('The document was replaced')
  children[0].emit('exit', 1)
  const replacementFrame = { postMessage: vi.fn() }
  const replacementSender = Object.assign(new EventEmitter(), {
    id: 5,
    mainFrame: replacementFrame,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///index.html'
  })
  const token = '55555555-5555-5555-5555-555555555555'
  const replacement = request('demand', replacementSender, token)
  children[1].emit('message', ready)
  await oldRead
  await oldPort
  await replacement
  expect(rig.call).not.toHaveBeenCalled()
  expect(
    frame.postMessage.mock.calls.filter(([channel]) => channel === BACKEND_PORT_DELIVERY)
  ).toHaveLength(0)
  expect(
    replacementFrame.postMessage.mock.calls.filter(([channel]) => channel === BACKEND_PORT_DELIVERY)
  ).toHaveLength(1)
  expect(
    children[1].postMessage.mock.calls.filter(([message]) => message.type === 'client')
  ).toEqual([[{ type: 'client', token }, [{}]]])
  const stopped = supervisor.stop()
  children[1].emit('spawn')
  expect(children[1].kill).toHaveBeenCalled()
  children[1].emit('exit', 0)
  await stopped
})
