import { describe, expect, it } from 'vitest'
import { createServeNetworkSourceGuard } from '../runtime/rpc/server/serve-network-source-policy'
import { zotzServerNetworkSources } from '../../shared/zotz/zotz-machine-mode'

describe('Zotz server mode source guard', () => {
  const guard = createServeNetworkSourceGuard({
    options: zotzServerNetworkSources({ zotzMachineMode: 'server' }),
    bindHost: '0.0.0.0',
    userDataPath: '/nonexistent-zotz-profile',
    devices: [],
    log: () => {}
  })

  it('admits this machine and the tailnet', () => {
    expect(guard?.admit('127.0.0.1')).toBe(true)
    expect(guard?.admit('100.101.102.103')).toBe(true)
    expect(guard?.admit('::ffff:100.64.0.1')).toBe(true)
    expect(guard?.admit('fd7a:115c:a1e0::1')).toBe(true)
  })

  it('refuses LAN and public peers', () => {
    expect(guard?.admit('192.168.1.20')).toBe(false)
    expect(guard?.admit('10.0.0.5')).toBe(false)
    expect(guard?.admit('8.8.8.8')).toBe(false)
  })
})
