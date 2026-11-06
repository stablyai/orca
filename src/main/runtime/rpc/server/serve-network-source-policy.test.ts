import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry } from './pairing/device-entry'
import {
  AuthenticatedSourceRecorder,
  NETWORK_SOURCE_POLICY_FILE,
  readNetworkSourcePolicy
} from './network-source-policy-store'
import {
  createServeNetworkSourceGuard,
  resolveServeNetworkSourcePolicy
} from './serve-network-source-policy'

function device(deviceId: string, pairedAt: number, extra: Partial<DeviceEntry> = {}): DeviceEntry {
  return { deviceId, name: deviceId, scope: 'runtime', pairedAt, lastSeenAt: pairedAt, ...extra }
}

const LOCAL = { allowPublic: false, pairingAddress: null }

describe('resolveServeNetworkSourcePolicy', () => {
  const record = { guardSince: 1_000 }

  it('enforces on a server with no paired devices', () => {
    expect(resolveServeNetworkSourcePolicy({ options: LOCAL, record, devices: [] })).toEqual({
      kind: 'local-only'
    })
  })

  it('grandfathers devices paired before the guard first ran, pending offers included', () => {
    const devices = [device('old', 900), device('offer', 1_000, { lastSeenAt: 0 })]
    expect(resolveServeNetworkSourcePolicy({ options: LOCAL, record, devices })).toEqual({
      kind: 'grandfathered',
      devices: 2
    })
  })

  it('enforces once only devices paired after the guard, or session-only rows, remain', () => {
    const devices = [device('new', 1_001), device('browser', 10, { ephemeral: true })]
    expect(resolveServeNetworkSourcePolicy({ options: LOCAL, record, devices })).toEqual({
      kind: 'local-only'
    })
  })

  it('allows public sources for --allow-public or a remembered public connection', () => {
    const devices = [device('new', 1_001)]
    expect(
      resolveServeNetworkSourcePolicy({
        options: { allowPublic: true, pairingAddress: null },
        record,
        devices
      })
    ).toEqual({ kind: 'public-allowed', reason: 'flag' })
    expect(
      resolveServeNetworkSourcePolicy({
        options: LOCAL,
        record: { ...record, allowPublicSources: true },
        devices
      })
    ).toEqual({ kind: 'public-allowed', reason: 'paired-public' })
  })

  it('refuses public sources early with --refuse-public on a grandfathered server', () => {
    expect(
      resolveServeNetworkSourcePolicy({
        options: { allowPublic: false, refusePublic: true, pairingAddress: 'vps.example.com' },
        record: { ...record, allowPublicSources: true },
        devices: [device('old', 900)]
      })
    ).toEqual({ kind: 'local-only', forced: true })
  })

  it.each([
    ['100.64.1.20', 'local-only'],
    ['192.168.1.5:6768', 'local-only'],
    ['[fd7a:115c:a1e0::5]:6768', 'local-only'],
    ['localhost', 'local-only'],
    ['203.0.113.9', 'public-allowed'],
    ['2001:db8::5', 'public-allowed'],
    ['devbox.example.com', 'public-allowed'],
    ['devbox', 'public-allowed'],
    ['wss://sandbox.example.com', 'public-allowed']
  ])('treats --pairing-address %s as %s', (pairingAddress, kind) => {
    expect(
      resolveServeNetworkSourcePolicy({
        options: { allowPublic: false, pairingAddress },
        record,
        devices: []
      }).kind
    ).toBe(kind)
  })
})

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

  it('stops refusing once an authenticated client connected from a public address', () => {
    expect(guardAt(2_000, [])).not.toBeNull()
    new AuthenticatedSourceRecorder(userDataPath).note('public')
    expect(guardAt(3_000, [])).toBeNull()
    expect(readNetworkSourcePolicy(userDataPath)).toEqual({
      allowPublicSources: true,
      guardSince: 2_000
    })
  })

  it('ignores a corrupt policy file instead of failing startup', () => {
    writeFileSync(join(userDataPath, NETWORK_SOURCE_POLICY_FILE), '{not json')
    expect(guardAt(2_000, [])).not.toBeNull()
  })

  it('does nothing outside serve or on a loopback bind', () => {
    const log = vi.fn()
    expect(
      createServeNetworkSourceGuard({
        options: null,
        bindHost: '0.0.0.0',
        userDataPath,
        devices: [],
        log
      })
    ).toBeNull()
    expect(
      createServeNetworkSourceGuard({
        options: LOCAL,
        bindHost: '127.0.0.1',
        userDataPath,
        devices: [],
        log
      })
    ).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(join(userDataPath, NETWORK_SOURCE_POLICY_FILE))).toBe(false)
  })
})
