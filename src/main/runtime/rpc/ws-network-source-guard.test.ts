import { describe, expect, it, vi } from 'vitest'
import { PublicSourceRefusal } from './ws-network-source-guard'

describe('PublicSourceRefusal', () => {
  it('admits loopback, LAN, link-local and Tailscale peers', () => {
    const guard = new PublicSourceRefusal(() => 0, vi.fn())
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:10.0.0.4',
      '172.20.1.1',
      '192.168.0.10',
      '169.254.3.3',
      'fe80::1%en0',
      'fd00::1',
      '100.101.102.103',
      'fd7a:115c:a1e0::9'
    ]) {
      expect(guard.admit(address)).toBe(true)
    }
  })

  it('refuses public peers and logs the flag once an hour', () => {
    let now = 0
    const log = vi.fn()
    const guard = new PublicSourceRefusal(() => now, log)
    expect(guard.admit('::ffff:203.0.113.9')).toBe(false)
    expect(guard.admit('2001:db8::1')).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain('203.0.113.9')
    expect(log.mock.calls[0]?.[0]).toContain('--allow-public')

    now = 60 * 60_000
    expect(guard.admit('198.51.100.1')).toBe(false)
    expect(log).toHaveBeenCalledTimes(2)
  })
})
