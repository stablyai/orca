import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry } from './pairing/device-entry'
import { readNetworkSourcePolicy } from './network-source-policy-store'
import {
  createServeNetworkSourceGuard,
  publicSourceRefusalNotice,
  resolveServeNetworkSourcePolicy
} from './serve-network-source-policy'

function device(deviceId: string, pairedAt: number, extra: Partial<DeviceEntry> = {}): DeviceEntry {
  return { deviceId, name: deviceId, scope: 'runtime', pairedAt, lastSeenAt: pairedAt, ...extra }
}

const LOCAL = { allowPublic: false, pairingAddress: null }

describe('createServeNetworkSourceGuard', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-serve-network-source-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function guardAt(now: number, devices: readonly DeviceEntry[], log = vi.fn()) {
    return createServeNetworkSourceGuard({
      options: LOCAL,
      bindHost: '0.0.0.0',
      userDataPath,
      devices,
      now,
      log
    })
  }

  it('keeps the first start as the grandfathering cutoff across restarts', () => {
    const log = vi.fn()
    expect(guardAt(2_000, [device('old', 1_500)], log)).toBeNull()
    expect(log.mock.calls[0]?.[0]).toContain('1 paired device(s) predate')
    expect(readNetworkSourcePolicy(userDataPath)).toEqual({ guardSince: 2_000 })

    // Still paired: still grandfathered, however long later.
    expect(guardAt(9_000_000, [device('old', 1_500), device('new', 3_000)])).toBeNull()

    const enforcing = guardAt(9_000_000, [device('new', 3_000)], log)
    expect(log.mock.calls.at(-1)?.[0]).toContain('public addresses are refused')
    expect(enforcing?.admit('192.168.1.20')).toBe(true)
    expect(enforcing?.admit('::ffff:100.100.1.2')).toBe(true)
    expect(enforcing?.admit('127.0.0.1')).toBe(true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(enforcing?.admit('203.0.113.9')).toBe(false)
  })
})

describe('resolveServeNetworkSourcePolicy --bind', () => {
  it.each([
    ['203.0.113.9', 'public-allowed'],
    ['0.0.0.0', 'local-only'],
    ['::', 'local-only'],
    ['192.168.1.5', 'local-only']
  ])('treats --bind %s as %s', (bindHost, kind) => {
    expect(
      resolveServeNetworkSourcePolicy({
        options: LOCAL,
        record: { guardSince: 1_000 },
        devices: [],
        bindHost
      }).kind
    ).toBe(kind)
  })
})

describe('publicSourceRefusalNotice', () => {
  function nic(address: string, family: 'IPv4' | 'IPv6', internal = false) {
    return { address, family, internal, netmask: '', mac: '', cidr: null, scopeid: 0 }
  }

  it('names a public IPv4 interface address but not LAN, loopback or global IPv6 ones', () => {
    expect(
      publicSourceRefusalNotice({
        lo: [nic('127.0.0.1', 'IPv4', true)],
        en0: [nic('192.168.1.5', 'IPv4'), nic('2001:db8::5', 'IPv6')]
      })
    ).toBeNull()
    expect(
      publicSourceRefusalNotice({ eth0: [nic('10.0.0.4', 'IPv4'), nic('203.0.113.9', 'IPv4')] })
    ).toContain('203.0.113.9')
  })
})
