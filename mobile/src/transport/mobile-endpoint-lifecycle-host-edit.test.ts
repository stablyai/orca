import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    const overlayWrites = (): number =>
      asyncStorageMock.setItem.mock.calls.filter(([key]) => key === OVERLAY_KEY).length

    logical.publishState('connected')
    await vi.waitFor(() => expect(overlayWrites()).toBe(1))

    await expectEditKept(relay)
    lifecycle.stop()
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
