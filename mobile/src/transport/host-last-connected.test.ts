import { describe, expect, it } from 'vitest'
import type { StoredHostProfile } from './types'
import { recordHostLastConnected } from './host-last-connected'

const HOST: StoredHostProfile = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://host-1',
  publicKeyB64: 'key-1',
  lastConnected: 1
}

describe('recordHostLastConnected', () => {
  it('updates only the matching host without mutating the input', () => {
    const other = { ...HOST, id: 'host-2' }
    const hosts = [HOST, other]

    expect(recordHostLastConnected(hosts, HOST.id, 42)).toEqual([
      { ...HOST, lastConnected: 42 },
      other
    ])
    expect(hosts).toEqual([HOST, other])
  })

  it('returns the same list when the host is absent', () => {
    const hosts = [HOST]
    expect(recordHostLastConnected(hosts, 'missing', 42)).toBe(hosts)
  })
})
