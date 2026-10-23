import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'

const { handlers, provider, adapter, adapters, restart } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<DaemonAsyncIoStatus>>(),
  provider: vi.fn(),
  adapter: { getDaemonIdentity: vi.fn(), getAsyncIoHealth: vi.fn() },
  adapters: vi.fn(),
  restart: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, handler: () => Promise<DaemonAsyncIoStatus>) =>
      handlers.set(name, handler)
  }
}))
vi.mock('../daemon/daemon-provider-state', () => ({ getDaemonProvider: provider }))
vi.mock('../daemon/daemon-provider-routing', () => ({
  getCurrentDaemonAdapter: () => adapter,
  getAllDaemonAdapters: adapters
}))
vi.mock('../daemon/daemon-provider-restart', () => ({ restartDaemon: restart }))

import { registerDaemonManagementHandlers } from './pty-management'

beforeEach(() => {
  vi.clearAllMocks()
  provider.mockReturnValue({})
  adapters.mockReturnValue([adapter])
  adapter.getDaemonIdentity.mockReturnValue({ pid: 123, launchNonce: 'original' })
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'stalled', pendingMs: 5000 })
  registerDaemonManagementHandlers()
})

async function read(): Promise<DaemonAsyncIoStatus | undefined> {
  return handlers.get('pty:management:asyncIoHealth')?.()
}

it('reports current-daemon health without restarting it or listing sessions', async () => {
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000 })
  expect(adapter.getAsyncIoHealth).toHaveBeenCalledOnce()
  expect(restart).not.toHaveBeenCalled()
})

it('discards health evidence if the daemon changes while the check is pending', async () => {
  let finish: (health: DaemonAsyncIoStatus) => void = () => {}
  adapter.getAsyncIoHealth.mockImplementationOnce(
    () =>
      new Promise<DaemonAsyncIoStatus>((resolve) => {
        finish = resolve
      })
  )
  const pending = read()
  adapter.getDaemonIdentity.mockReturnValue({ pid: 456, launchNonce: 'replacement' })
  finish({ state: 'stalled', pendingMs: 5000 })
  expect(await pending).toEqual({ state: 'unverifiable' })
  expect(restart).not.toHaveBeenCalled()
})

it('does not install a daemon when no provider exists', async () => {
  provider.mockReturnValue(null)
  expect(await read()).toEqual({ state: 'unverifiable' })
  expect(adapter.getAsyncIoHealth).not.toHaveBeenCalled()
})

function legacyAdapter(state: DaemonAsyncIoStatus) {
  return {
    getDaemonIdentity: vi.fn().mockReturnValue({ pid: 789, launchNonce: 'legacy' }),
    getAsyncIoHealth: vi.fn().mockResolvedValue(state),
    listSessions: vi.fn()
  }
}

it('reports a stalled legacy owner even when the current daemon is healthy', async () => {
  const legacy = legacyAdapter({ state: 'stalled', pendingMs: 9000 })
  adapters.mockReturnValue([adapter, legacy])
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 9000 })
  expect(legacy.getAsyncIoHealth).toHaveBeenCalledOnce()
  expect(adapter.getAsyncIoHealth).toHaveBeenCalledOnce()
  expect(legacy.listSessions).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

it('does not hide a proven stall behind an unreachable peer', async () => {
  adapters.mockReturnValue([adapter, legacyAdapter({ state: 'unverifiable' })])
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000 })
})

it('does not certify recovery when a retained owner is unreachable', async () => {
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  adapters.mockReturnValue([adapter, legacyAdapter({ state: 'unverifiable' })])
  expect(await read()).toEqual({ state: 'unverifiable' })
})

it('reports recovery only after every owner answers healthy', async () => {
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  adapters.mockReturnValue([adapter, legacyAdapter({ state: 'healthy', pendingMs: 2 })])
  expect(await read()).toEqual({ state: 'healthy', pendingMs: 2 })
})

it('discards a removed legacy owner without hiding recovery of the remaining owner', async () => {
  const legacy = legacyAdapter({ state: 'stalled', pendingMs: 9000 })
  adapters.mockReturnValue([adapter, legacy])
  adapter.getAsyncIoHealth.mockImplementationOnce(async () => {
    adapters.mockReturnValue([adapter])
    return { state: 'healthy', pendingMs: 0 }
  })
  expect(await read()).toEqual({ state: 'healthy', pendingMs: 0 })
})

it('does not certify a newly adopted owner from an older health snapshot', async () => {
  adapter.getAsyncIoHealth.mockImplementationOnce(async () => {
    adapters.mockReturnValue([adapter, legacyAdapter({ state: 'stalled', pendingMs: 9000 })])
    return { state: 'healthy', pendingMs: 0 }
  })
  expect(await read()).toEqual({ state: 'unverifiable' })
})

it('contains an unexpected peer rejection without hiding a proven stall', async () => {
  const legacy = legacyAdapter({ state: 'healthy', pendingMs: 0 })
  legacy.getAsyncIoHealth.mockRejectedValue(new Error('lost peer'))
  adapters.mockReturnValue([adapter, legacy])
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000 })
})

it('discards the snapshot when its provider is replaced', async () => {
  adapter.getAsyncIoHealth.mockImplementationOnce(async () => {
    provider.mockReturnValue({})
    return { state: 'stalled', pendingMs: 5000 }
  })
  expect(await read()).toEqual({ state: 'unverifiable' })
})

it('clears a recovered supported owner beside an older peer without the probe', async () => {
  const legacy = legacyAdapter({ state: 'unsupported' })
  adapters.mockReturnValue([adapter, legacy])
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000 })
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  expect(await read()).toEqual({ state: 'healthy', pendingMs: 0 })
})

it('reports unsupported when none of the owners implement the probe', async () => {
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'unsupported' })
  adapters.mockReturnValue([adapter, legacyAdapter({ state: 'unsupported' })])
  expect(await read()).toEqual({ state: 'unsupported' })
})

it('does not advertise recovery for a degraded current owner whose fallback terminals must survive', async () => {
  provider.mockReturnValue(Object.create(DegradedDaemonPtyProvider.prototype))
  adapter.getAsyncIoHealth.mockResolvedValue({
    state: 'stalled',
    pendingMs: 5000,
    recoverySupported: true
  })
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000, recoverySupported: false })
  expect(restart).not.toHaveBeenCalled()
})

it('keeps targeted recovery available for a legacy owner beside a degraded current owner', async () => {
  provider.mockReturnValue(Object.create(DegradedDaemonPtyProvider.prototype))
  adapter.getAsyncIoHealth.mockResolvedValue({ state: 'healthy', pendingMs: 0 })
  adapters.mockReturnValue([
    adapter,
    legacyAdapter({ state: 'stalled', pendingMs: 5000, recoverySupported: true })
  ])
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000, recoverySupported: true })
})

it('accepts fresh identity snapshots from the same authenticated daemon', async () => {
  adapter.getDaemonIdentity.mockImplementation(() => ({
    pid: 123,
    startedAtMs: 456,
    launchNonce: 'original'
  }))
  expect(await read()).toEqual({ state: 'stalled', pendingMs: 5000 })
})

it.each([
  { pid: 124, startedAtMs: 456, launchNonce: 'original' },
  { pid: 123, startedAtMs: 457, launchNonce: 'original' },
  { pid: 123, startedAtMs: 456, launchNonce: 'replacement' },
  null
])(
  'rejects fresh identity snapshots from a changed or disconnected daemon: %j',
  async (changed) => {
    adapter.getDaemonIdentity.mockImplementation(() => ({
      pid: 123,
      startedAtMs: 456,
      launchNonce: 'original'
    }))
    adapter.getAsyncIoHealth.mockImplementationOnce(async () => {
      adapter.getDaemonIdentity.mockReturnValue(changed)
      return { state: 'stalled', pendingMs: 5000 }
    })
    expect(await read()).toEqual({ state: 'unverifiable' })
  }
)
