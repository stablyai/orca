import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BACKEND_CONNECTION_CHANGED,
  BACKEND_PORT_REQUEST
} from '../../shared/backend-service-contract'
const rig = vi.hoisted(() => ({ fork: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
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
    close() {}
  }
}))
vi.mock('../backend/backend-message-port', () => ({ backendMessagePort: () => ({}) }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('../worker-threads/worker-thread-entry-path', () => ({
  currentWorkerEntryLayout: () => ({ moduleDir: '/' }),
  resolveWorkerThreadEntryPath: () => 'backend-entry.js'
}))
vi.mock('../window/renderer-document-navigation', () => ({
  isRendererDocumentNavigation: () => true
}))
vi.mock('../usage/usage-worktree-metadata', () => ({ loadKnownUsageWorktreesByRepo: vi.fn() }))
vi.mock('../claude-usage/transcript-file-discovery', () => ({
  claudeProfileTranscriptDirs: vi.fn()
}))
vi.mock('../telemetry/client', () => ({ isTelemetryEnabled: vi.fn(), track: vi.fn() }))
import { BackendSupervisor } from './backend-supervisor'
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
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
  const supervisor = new BackendSupervisor({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
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
