import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

const storage = vi.hoisted(() => new Map<string, string>())
const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    storage.set(key, value)
  }),
  removeItem: vi.fn(async (key: string) => {
    storage.delete(key)
  })
}))
const secureStoreMock = vi.hoisted(() => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async () => 'device-token'),
  setItemAsync: vi.fn(async () => {}),
  deleteItemAsync: vi.fn(async () => {})
}))
const connectMock = vi.hoisted(() => vi.fn())
const openRelayMock = vi.hoisted(() => vi.fn())
const resolveRelayMock = vi.hoisted(() => vi.fn())
const readBundleMock = vi.hoisted(() => vi.fn())
const writeBundleMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('expo-secure-store', () => secureStoreMock)
vi.mock('./rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rpc-client')>()),
  connect: (...args: unknown[]) => connectMock(...args)
}))
vi.mock('./mobile-relay-rpc-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-relay-rpc-session')>()),
  connectMobileRelayRpcSession: (...args: unknown[]) => openRelayMock(...args)
}))
vi.mock('./mobile-relay-resume-director', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-relay-resume-director')>()),
  resolveMobileRelayEndpoint: (...args: unknown[]) => resolveRelayMock(...args)
}))
vi.mock('./mobile-relay-credential-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mobile-relay-credential-bundle')>()),
  readMobileRelayCredentialBundle: (...args: unknown[]) => readBundleMock(...args),
  writeMobileRelayCredentialBundle: (...args: unknown[]) => writeBundleMock(...args)
}))

import { loadHosts, resetHostStoreForTests, updateHostNameAndEndpoint } from './host-store'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import {
  bundle,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  mockCredentialRotation,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'
import { createMobileRelayDirectUpgradeJournal } from './mobile-relay-direct-upgrade-journal'
import { upgradeDirectMobileRelay } from './mobile-relay-direct-upgrade'

const OVERLAY_KEY = 'orca:mobile-relay:host-overlays:v2'
const EDITED_ENDPOINT = 'ws://192.168.1.20:6768'
const resolved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }

// Starts a relay host whose first dial hits the wrong cell, leaving director resolution pending.
async function startWithPendingResolution(): Promise<{
  logical: FakeLogicalClient
  lifecycle: ReturnType<typeof startMobileEndpointLifecycle>
  settle: (value: MobileRelayEndpoint) => void
}> {
  let settle: (value: MobileRelayEndpoint) => void = () => {}
  resolveRelayMock.mockReturnValue(
    new Promise<MobileRelayEndpoint>((resolve) => {
      settle = resolve
    })
  )
  openRelayMock
    .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
    .mockReturnValue(new FakeRelaySession('connected'))
  const logical = new FakeLogicalClient('disconnected', 'lan')
  const lifecycle = startMobileEndpointLifecycle(logical, host, () => {})
  await vi.waitFor(() => expect(resolveRelayMock).toHaveBeenCalledOnce())
  return { logical, lifecycle, settle: (value) => settle(value) }
}

function overlayWrites(): number {
  return asyncStorageMock.setItem.mock.calls.filter(([key]) => key === OVERLAY_KEY).length
}

async function expectEditKept(expectedRelay: MobileRelayEndpoint): Promise<void> {
  const [saved] = await loadHosts()
  expect(saved).toMatchObject({
    name: 'Renamed',
    endpoint: EDITED_ENDPOINT,
    deviceToken: 'device-token',
    relay: expectedRelay
  })
  expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
}

describe('mobile endpoint lifecycle host edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    const { id, name, endpoint, publicKeyB64, lastConnected } = host
    storage.set('orca:hosts', JSON.stringify([{ id, name, endpoint, publicKeyB64, lastConnected }]))
    storage.set(
      OVERLAY_KEY,
      JSON.stringify([
        {
          v: 2,
          hostId: id,
          endpoints: [
            { id: 'direct-primary', kind: 'lan', url: endpoint },
            { id: 'relay-primary', kind: 'relay', url: 'wss://relay-c1.onorca.dev/v1/connect/id' }
          ],
          relayHostId: relay.relayHostId,
          relay
        }
      ])
    )
    connectMock.mockImplementation(() => new FakeSession('disconnected'))
    readBundleMock.mockResolvedValue(bundle)
  })

  it('keeps an edit made while relay resolution was pending', async () => {
    const { lifecycle, settle } = await startWithPendingResolution()

    await updateHostNameAndEndpoint(host.id, { personalName: 'Renamed', endpoint: EDITED_ENDPOINT })
    settle(resolved)
    await vi.waitFor(() => expect(openRelayMock).toHaveBeenCalledTimes(2))

    await expectEditKept(resolved)
    lifecycle.stop()
  })

  it('does not persist a resolution that settles after stop', async () => {
    const { logical, lifecycle, settle } = await startWithPendingResolution()
    await updateHostNameAndEndpoint(host.id, { personalName: 'Renamed', endpoint: EDITED_ENDPOINT })
    const writesBeforeSettle = asyncStorageMock.setItem.mock.calls.length

    lifecycle.stop()
    const recoveryPathCalls = logical.setRecoveryPath.mock.calls.length
    settle(resolved)
    // The withdrawn dial clears the recovery path only after any persistence has run.
    await vi.waitFor(() =>
      expect(logical.setRecoveryPath).toHaveBeenCalledTimes(recoveryPathCalls + 1)
    )

    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(writesBeforeSettle)
    await expectEditKept(relay)
    expect(openRelayMock).toHaveBeenCalledOnce()
  })

  it('keeps an edit made before a credential rotation publishes its relay', async () => {
    readBundleMock.mockResolvedValue({
      ...bundle,
      current: { ...bundle.current, expiresAt: Date.now() + 60_000 }
    })
    const logical = new FakeLogicalClient('connected', 'lan')
    mockCredentialRotation(logical)
    const lifecycle = startMobileEndpointLifecycle(logical, host, () => {})
    await updateHostNameAndEndpoint(host.id, { personalName: 'Renamed', endpoint: EDITED_ENDPOINT })

    logical.publishState('connected')
    await vi.waitFor(() => expect(overlayWrites()).toBe(1))

    await expectEditKept(relay)
    lifecycle.stop()
  })

  it('does not persist relay routing from a rotation that finishes after stop', async () => {
    readBundleMock.mockResolvedValue({
      ...bundle,
      current: { ...bundle.current, expiresAt: Date.now() + 60_000 }
    })
    let finishCredentialWrite: () => void = () => {}
    writeBundleMock.mockResolvedValueOnce().mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCredentialWrite = resolve
      })
    )
    const logical = new FakeLogicalClient('connected', 'lan')
    mockCredentialRotation(logical)
    const lifecycle = startMobileEndpointLifecycle(logical, host, () => {})
    await updateHostNameAndEndpoint(host.id, { personalName: 'Renamed', endpoint: EDITED_ENDPOINT })

    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundleMock).toHaveBeenCalledTimes(2))
    lifecycle.stop()
    finishCredentialWrite()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The rotated bundle itself stays durable; only the stale relay routing write is skipped.
    expect(writeBundleMock).toHaveBeenCalledTimes(2)
    expect(overlayWrites()).toBe(0)
    await expectEditKept(relay)
  })

  it('keeps an edit made while a direct-only host was being upgraded to relay', async () => {
    storage.set(OVERLAY_KEY, '[]')
    const { relay: _relay, ...directHost } = host
    const journal = createMobileRelayDirectUpgradeJournal(host.id, (length) =>
      new Uint8Array(length).fill(3)
    )
    const installed = {
      v: 1,
      reqId: journal.reqId,
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: 9_999_999
    }
    const client = new FakeSession('connected')
    client.sendRequest.mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: {
        v: 1,
        relay,
        installStatus: { v: 1, reqId: journal.reqId, state: 'committed', result: installed }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await updateHostNameAndEndpoint(host.id, { personalName: 'Renamed', endpoint: EDITED_ENDPOINT })

    // `directHost` is the controller's pre-edit snapshot; only the default routing writer runs.
    await upgradeDirectMobileRelay({
      client,
      host: directHost,
      dependencies: {
        readJournal: async () => journal,
        clearJournal: async () => {},
        writeBundle: async () => {}
      }
    })

    await expectEditKept(relay)
  })
})

const refreshedLan = 'ws://192.168.1.50:6768'
const refreshedTailscale = 'ws://100.64.0.2:6768'

function advertised(url: string, kind: 'lan' | 'tailscale') {
  return {
    id: 'rpc-1',
    ok: true as const,
    result: {
      v: 1 as const,
      selected: { kind, url },
      endpoints: [{ kind, url }]
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('mobile endpoint lifecycle direct refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
    vi.clearAllMocks()
    storage.clear()
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    const { id, name, endpoint, publicKeyB64, lastConnected } = host
    storage.set('orca:hosts', JSON.stringify([{ id, name, endpoint, publicKeyB64, lastConnected }]))
    storage.set(
      OVERLAY_KEY,
      JSON.stringify([
        {
          v: 2,
          hostId: id,
          endpoints: [
            {
              id: 'relay-primary',
              kind: 'relay',
              url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
            }
          ],
          relayHostId: relay.relayHostId,
          relay
        }
      ])
    )
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      storage.set(key, value)
    })
    openRelayMock.mockReset()
    connectMock.mockReset()
    readBundleMock.mockResolvedValue(bundle)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps dialing the stored endpoint when the refresh save fails', async () => {
    const relaySession = new FakeRelaySession('connected')
    relaySession.sendRequest.mockResolvedValue(advertised(refreshedLan, 'lan'))
    openRelayMock.mockReturnValue(relaySession)
    connectMock.mockImplementation(() => new FakeSession('connected'))
    asyncStorageMock.setItem.mockImplementation(async (key: string, value: string) => {
      if (key === 'orca:hosts' && value.includes(refreshedLan)) {
        throw new Error('disk full')
      }
      storage.set(key, value)
    })
    const logical = new FakeLogicalClient('disconnected', 'lan')
    logical.sendRequest.mockResolvedValue(advertised(refreshedLan, 'lan'))

    const lifecycle = startMobileEndpointLifecycle(logical, host, () => {})
    await vi.advanceTimersByTimeAsync(20_000)

    expect(connectMock).toHaveBeenCalled()
    expect(connectMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([host.endpoint])
    const saved = JSON.parse(storage.get('orca:hosts')!) as { id: string; endpoint: string }[]
    expect(saved.find((row) => row.id === host.id)?.endpoint).toBe(host.endpoint)
    lifecycle.stop()
  })

  it('migrates the refreshed tailscale dial on the tailscale path', async () => {
    const relaySession = new FakeRelaySession('connected')
    relaySession.sendRequest.mockResolvedValue(advertised(refreshedTailscale, 'tailscale'))
    openRelayMock.mockReturnValue(relaySession)
    connectMock.mockImplementation(() => new FakeSession('connected'))
    const logical = new FakeLogicalClient('disconnected', 'lan')
    logical.sendRequest.mockResolvedValue(advertised(refreshedTailscale, 'tailscale'))

    const lifecycle = startMobileEndpointLifecycle(logical, host, () => {})
    await vi.advanceTimersByTimeAsync(90_000)

    expect(connectMock.mock.calls.map(([endpoint]) => endpoint)).toEqual(
      expect.arrayContaining([refreshedTailscale])
    )
    expect(connectMock.mock.calls.every(([endpoint]) => endpoint === refreshedTailscale)).toBe(true)
    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeSession),
      'tailscale',
      undefined,
      expect.any(Function)
    )
    lifecycle.stop()
  })
})
