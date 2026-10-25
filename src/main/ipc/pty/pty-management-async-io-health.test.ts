import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonAsyncIoStatus } from '../../../shared/daemon-async-io-health'

const { handlers, provider, adapter, restart } = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<DaemonAsyncIoStatus>>(),
  provider: vi.fn(),
  adapter: { getDaemonIdentity: vi.fn(), getAsyncIoHealth: vi.fn() },
  restart: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, handler: () => Promise<DaemonAsyncIoStatus>) =>
      handlers.set(name, handler)
  }
}))
vi.mock('../../daemon/daemon-provider-state', () => ({ getDaemonProvider: provider }))
vi.mock('../../daemon/daemon-provider-routing', () => ({ getCurrentDaemonAdapter: () => adapter }))
vi.mock('../../daemon/daemon-provider-restart', () => ({ restartDaemon: restart }))

import { registerDaemonManagementHandlers } from './pty-management'

beforeEach(() => {
  vi.clearAllMocks()
  provider.mockReturnValue({})
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
