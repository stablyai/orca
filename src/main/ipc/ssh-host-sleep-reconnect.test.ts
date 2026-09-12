import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  off: vi.fn(),
  on: vi.fn(),
  blocked: vi.fn().mockReturnValue(false),
  getConnection: vi.fn(),
  reconnect: vi.fn().mockResolvedValue(undefined),
  recoverManagedTunnels: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({ powerMonitor: { off: mocks.off, on: mocks.on } }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  recoverOrcadManagedTunnelsAfterHostResume: mocks.recoverManagedTunnels
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: new Map() }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getConnection: mocks.getConnection, reconnect: mocks.reconnect }
}))
vi.mock('./ssh-reset-production-state', () => ({ isSshResetAdmissionBlocked: mocks.blocked }))
import { activeSessions } from './ssh-active-relay-sessions'
import type { SshRelaySession } from '../ssh/ssh-relay-session'

import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'

describe('SSH host sleep reconnect', () => {
  afterEach(() => {
    unregisterPowerMonitorReconnect()
    mocks.off.mockReset()
    mocks.on.mockReset()
    mocks.recoverManagedTunnels.mockReset().mockResolvedValue(undefined)
    mocks.blocked.mockReset().mockReturnValue(false)
    mocks.getConnection.mockReset()
    mocks.reconnect.mockReset().mockResolvedValue(undefined)
    activeSessions.clear()
  })

  it('runs managed-tunnel wake recovery with the production probe policy', async () => {
    registerPowerMonitorReconnect(() => '/canonical-user-data')
    const resume = mocks.on.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resume).toBeTypeOf('function')

    resume()

    await vi.waitFor(() =>
      expect(mocks.recoverManagedTunnels).toHaveBeenCalledWith('/canonical-user-data', {
        attempts: 2,
        timeoutMs: 5_000
      })
    )
  })

  it('does not probe or suspend resources owned by a retained reset', () => {
    const probeLiveness = vi.fn()
    const prepareForHostSleep = vi.fn()
    activeSessions.set('target', {
      prepareForHostSleep,
      getMux: () => ({ isDisposed: () => false, probeLiveness })
    } as unknown as SshRelaySession)
    mocks.blocked.mockReturnValue(true)
    registerPowerMonitorReconnect()
    mocks.on.mock.calls.find(([event]) => event === 'suspend')![1]()
    mocks.on.mock.calls.find(([event]) => event === 'resume')![1]()
    expect(prepareForHostSleep).not.toHaveBeenCalled()
    expect(probeLiveness).not.toHaveBeenCalled()
    expect(mocks.reconnect).not.toHaveBeenCalled()
  })

  it('rechecks reset admission after the awaited wake probe', async () => {
    let settle!: (alive: boolean) => void
    const probeLiveness = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            settle = resolve
          })
      )
      .mockResolvedValue(false)
    activeSessions.set('target', {
      getMux: () => ({ isDisposed: () => false, probeLiveness })
    } as unknown as SshRelaySession)
    mocks.getConnection.mockReturnValue({})
    registerPowerMonitorReconnect()
    mocks.on.mock.calls.find(([event]) => event === 'resume')![1]()
    expect(probeLiveness).toHaveBeenCalledTimes(1)
    mocks.blocked.mockReturnValue(true)
    settle(false)
    await vi.waitFor(() => expect(mocks.blocked).toHaveBeenCalledTimes(4))
    expect(probeLiveness).toHaveBeenCalledTimes(1)
    expect(mocks.reconnect).not.toHaveBeenCalled()
  })
})
