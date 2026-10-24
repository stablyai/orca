import { afterEach, describe, expect, it, vi } from 'vitest'

const recoverManagedTunnels = vi.hoisted(() => vi.fn(async () => {}))
const retryStalledReconnects = vi.hoisted(() => vi.fn((): string[] => []))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: new EventEmitter() }
})
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  recoverOrcadManagedTunnelsAfterHostResume: recoverManagedTunnels
}))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ retryStalledReconnects })
}))

import { powerMonitor } from 'electron'
import {
  registerPowerMonitorReconnect,
  retrySshConnectionsAfterNetworkReturn,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'

describe('host sleep reconnect', () => {
  afterEach(() => {
    unregisterPowerMonitorReconnect()
    vi.clearAllMocks()
  })

  it('recovers managed tunnels with the same probe policy', async () => {
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
    registerPowerMonitorReconnect()
    powerMonitor.emit('resume')
    await new Promise((resolve) => setImmediate(resolve))
    expect(recoverManagedTunnels).not.toHaveBeenCalled()
  })

  it.each(['resume', 'unlock-screen'])(
    'restarts stalled SSH reconnects on %s (#26888)',
    (event) => {
      registerPowerMonitorReconnect(() => '/user-data')
      powerMonitor.emit(event)
      expect(retryStalledReconnects).toHaveBeenCalledTimes(1)
    }
  )

  it('restarts stalled SSH reconnects and re-probes tunnels when the window reports the network back', async () => {
    registerPowerMonitorReconnect(() => '/user-data')
    retrySshConnectionsAfterNetworkReturn()
    expect(retryStalledReconnects).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(recoverManagedTunnels).toHaveBeenCalledTimes(1))
  })

  it('stops listening once unregistered', () => {
    registerPowerMonitorReconnect(() => '/user-data')
    unregisterPowerMonitorReconnect()
    powerMonitor.emit('resume')
    powerMonitor.emit('unlock-screen')
    expect(retryStalledReconnects).not.toHaveBeenCalled()
  })
})
