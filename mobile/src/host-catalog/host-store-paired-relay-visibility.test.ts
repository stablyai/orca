import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInMemoryAsyncStorage } from '../test-support/in-memory-async-storage'
import type { HostProfile } from './host-profile'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: createInMemoryAsyncStorage()
}))

// The phone keychain is the slow step of a pairing save; each token write waits for the test to release it.
const keychain = vi.hoisted(() => ({
  tokens: new Map<string, string>(),
  onWriteStarted: () => {},
  releaseWrite: () => {}
}))
vi.mock('../host-credentials/host-device-token-store', () => ({
  readHostDeviceToken: async (hostId: string) => keychain.tokens.get(hostId) ?? null,
  writeHostDeviceToken: (hostId: string, token: string) =>
    new Promise<void>((resolve) => {
      keychain.releaseWrite = () => {
        keychain.tokens.set(hostId, token)
        resolve()
      }
      keychain.onWriteStarted()
    }),
  deleteHostDeviceToken: async () => {}
}))

function holdNextTokenWrite(): Promise<void> {
  return new Promise((resolve) => {
    keychain.onWriteStarted = resolve
  })
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://orca.s-dev.io',
  cellUrl: 'https://orca.s-dev.io',
  assignmentEpoch: 1,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

const newRelayHost: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://10.0.1.67:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  relay
}

const cachedDirectHost: HostProfile = {
  id: 'host-2',
  name: 'Red Fox',
  endpoint: 'ws://10.0.1.68:6768',
  deviceToken: 'old-token',
  publicKeyB64: 'B'.repeat(44),
  lastConnected: 1
}

describe('a host saved from a relay-capable pairing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    keychain.tokens.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is never read back without its relay routing', async () => {
    const { savePairedHost, loadHosts } = await import('./host-store')
    const tokenWriteStarted = holdNextTokenWrite()
    const saving = savePairedHost(newRelayHost)
    await tokenWriteStarted

    // Read while the keychain write is pending; the token lands before the read finishes.
    const loading = loadHosts()
    await Promise.resolve()
    keychain.releaseWrite()
    await saving

    const hosts = await loading
    expect(hosts.find(({ id }) => id === 'host-1')?.relay?.relayHostId).toBe('AbCdEf0123_-xyZ9')
  })

  it('is not read back as the old direct-only entry while its re-pair is still saving', async () => {
    const { savePairedHost, loadHosts } = await import('./host-store')
    const firstWriteStarted = holdNextTokenWrite()
    const firstSave = savePairedHost(cachedDirectHost)
    await firstWriteStarted
    keychain.releaseWrite()
    await firstSave
    await loadHosts()

    const secondWriteStarted = holdNextTokenWrite()
    const repairing = savePairedHost({ ...cachedDirectHost, deviceToken: 'new-token', relay })
    await secondWriteStarted

    // The token write is still pending: nothing has completed since this read starts, yet the stored host is half-republished.
    const loading = loadHosts()
    await vi.advanceTimersByTimeAsync(0)
    keychain.releaseWrite()
    await repairing

    const host = (await loading).find(({ id }) => id === 'host-2')
    expect(host?.relay?.relayHostId).toBe('AbCdEf0123_-xyZ9')
    expect(host?.deviceToken).toBe('new-token')
  })
})
