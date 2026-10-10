import { afterEach, describe, expect, it, vi } from 'vitest'

const manager = vi.hoisted(() => {
  const connection = {}
  return { getConnection: vi.fn(() => connection), reconnect: vi.fn(async () => {}) }
})
const recoverManagedTunnels = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: new EventEmitter() }
})
vi.mock('./ssh-ipc-context', () => ({ connectionManager: manager }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  recoverOrcadManagedTunnelsAfterHostResume: recoverManagedTunnels
}))

import { powerMonitor } from 'electron'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'

function plainSession(probe: () => Promise<boolean>) {
  return {
    prepareForHostSleep: vi.fn(),
    getMux: () => null,
    getPlainSshSession: () => ({ probeTransport: vi.fn(probe) })
  }
}

async function resumeAndSettle(): Promise<void> {
  powerMonitor.emit('resume')
  await vi.waitFor(() => expect(manager.getConnection).toHaveBeenCalled())
  await new Promise((resolve) => setImmediate(resolve))
}

describe('host sleep reconnect in plain SSH mode', () => {
  afterEach(() => {
    unregisterPowerMonitorReconnect()
    activeSessions.clear()
    vi.clearAllMocks()
  })

  it('keeps plain shells when the SSH transport still answers after resume', async () => {
    const session = plainSession(async () => true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume path only calls the methods stubbed here.
    activeSessions.set('target-1', session as never)
    registerPowerMonitorReconnect()
    await resumeAndSettle()
    expect(manager.reconnect).not.toHaveBeenCalled()
  })

  it('reconnects when the plain SSH transport stops answering', async () => {
    const session = plainSession(async () => false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume path only calls the methods stubbed here.
    activeSessions.set('target-1', session as never)
    registerPowerMonitorReconnect()
    powerMonitor.emit('resume')
    await vi.waitFor(() => expect(manager.reconnect).toHaveBeenCalledWith('target-1'))
  })

  it('recovers managed tunnels with the same probe policy, even with no relay sessions', async () => {
    registerPowerMonitorReconnect(() => '/user-data')
    powerMonitor.emit('resume')
    await vi.waitFor(() =>
      expect(recoverManagedTunnels).toHaveBeenCalledWith('/user-data', {
        attempts: 2,
        timeoutMs: 5_000
      })
    )
  })

  it('leaves managed tunnels alone when the caller supplies no profile path', async () => {
    const session = plainSession(async () => true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume path only calls the methods stubbed here.
    activeSessions.set('target-1', session as never)
    registerPowerMonitorReconnect()
    await resumeAndSettle()
    expect(recoverManagedTunnels).not.toHaveBeenCalled()
  })
})
