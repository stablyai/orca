import { afterEach, describe, expect, it, vi } from 'vitest'

const recoverManagedTunnels = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: new EventEmitter() }
})
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  recoverOrcadManagedTunnelsAfterHostResume: recoverManagedTunnels
}))

import { powerMonitor } from 'electron'
import {
  registerPowerMonitorReconnect,
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
})
