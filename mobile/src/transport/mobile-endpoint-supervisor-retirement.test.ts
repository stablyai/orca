import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import {
  MobileEndpointSupervisor,
  type MobileEndpointSupervisorDependencies
} from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))
const secureStoreMock = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn()
}))
const hostStoreMock = vi.hoisted(() => ({ loadStoredHostIdentity: vi.fn() }))
const tokenStoreMock = vi.hoisted(() => ({ readHostDeviceToken: vi.fn() }))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  ...secureStoreMock
}))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('./host-store', () => hostStoreMock)
vi.mock('./host-device-token-store', () => tokenStoreMock)

import {
  deleteMobileRelayCredentialBundleIfCurrent,
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import {
  MobileRelayUpgradeLifecycleRetiredError,
  writeExistingHostRelayCredentialBundle
} from './existing-host-relay-routing'
import {
  beginHostEndpointPublicationLifecycle,
  resetHostProfilePublicationForTests
} from './host-profile-publication'
import { resetPairingKeychainForTests } from './pairing-keychain'

class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn(
    async (_method: string, _params?: unknown): Promise<RpcResponse> => ({
      id: 'rpc-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  readonly subscribe = vi.fn(() => () => {})
  readonly updateTerminalSubscriptionViewport = vi.fn()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private readonly listeners = new Set<(state: ConnectionState) => void>()

  constructor(private state: ConnectionState) {}

  getState = () => this.state
  getReconnectAttempt = () => 0
  getLastConnectedAt = () => null
  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

class FakeRelaySession extends FakeSession implements MobileRelayRpcSession {
  constructor(
    state: ConnectionState,
    private readonly failure: Error | null = null
  ) {
    super(state)
  }
  getAttachDeadlineAt = () => Date.now() + 10_000
  getResumeExpiresAt = () => Date.now() + 120_000
  getResumeConfirmation = () => null
  getFailure = () => this.failure
}

class FakeLogicalClient extends FakeSession implements StableLogicalRpcClient {
  private generation = 1

  constructor(
    state: ConnectionState,
    private path: MobileConnectionPath
  ) {
    super(state)
  }

  migrateTo = vi.fn(async (session: RpcClient, path: MobileConnectionPath) => {
    if (session.getState() !== 'connected') {
      session.close()
      throw new Error(`replacement session ${session.getState()}`)
    }
    this.path = path
    this.generation += 1
    this.publishState('connected')
  })
  suspendActiveSession = vi.fn(() => this.publishState('disconnected'))
  getActivePath = () => this.path
  getGeneration = () => this.generation
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  relayHostId: relay.relayHostId,
  relay
}
const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: host.id,
  deviceToken: host.deviceToken,
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 2,
    expiresAt: Number.MAX_SAFE_INTEGER
  }
}

function dependencies(
  overrides: Partial<MobileEndpointSupervisorDependencies> = {}
): MobileEndpointSupervisorDependencies {
  return {
    openDirect: vi.fn(() => new FakeSession('connected')),
    openRelay: vi.fn(() => new FakeRelaySession('connected')),
    resolveRelay: vi.fn(async ({ relay }) => relay),
    readBundle: vi.fn(async () => bundle),
    writeBundle: vi.fn(async () => {}),
    saveHost: vi.fn(async () => {}),
    now: Date.now,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides
  }
}

function mockCredentialRotation(logical: FakeLogicalClient): void {
  let installed: Record<string, unknown> | null = null
  logical.sendRequest.mockImplementation(async (method, params) => {
    const request = params as { installReqId?: string; reqId?: string }
    if (method === 'pairing.provisionRelay') {
      installed = {
        v: 1,
        reqId: request.reqId,
        authorizationMode: 'authenticated-direct',
        currentVersion: 3,
        resumeExpiresAt: Date.now() + 300_000,
        graceExpiresAt: Date.now() + 60_000
      }
      return { id: 'rpc-2', ok: true, result: installed, _meta: { runtimeId: 'runtime-1' } }
    }
    return {
      id: 'rpc-1',
      ok: true,
      result: {
        v: 1,
        relay,
        installStatus: installed
          ? { v: 1, reqId: request.installReqId, state: 'committed', result: installed }
          : { v: 1, reqId: request.installReqId, state: 'not-found' }
      },
      _meta: { runtimeId: 'runtime-1' }
    }
  })
}

describe('mobile endpoint supervisor retirement', () => {
  let storedCredentialRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
    resetPairingKeychainForTests()
    resetHostProfilePublicationForTests()
    storedCredentialRaw = null
    asyncStorageMock.getItem.mockResolvedValue(null)
    asyncStorageMock.setItem.mockResolvedValue(undefined)
    asyncStorageMock.removeItem.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockImplementation(async () => storedCredentialRaw)
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      storedCredentialRaw = value
    })
    secureStoreMock.deleteItemAsync.mockImplementation(async () => {
      storedCredentialRaw = null
    })
    hostStoreMock.loadStoredHostIdentity.mockResolvedValue(host)
    tokenStoreMock.readHostDeviceToken.mockResolvedValue(host.deviceToken)
  })

  afterEach(() => vi.useRealTimers())

  it('does not publish a resolved relay profile after stopping', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishResolve: ((value: typeof relay) => void) | undefined
    const resolvePending = new Promise<typeof relay>((resolve) => {
      finishResolve = resolve
    })
    const onHostUpdated = vi.fn()
    const deps = dependencies({
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4409))),
      resolveRelay: vi.fn(() => resolvePending),
      onHostUpdated
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.stop()
    finishResolve?.(relay)
    await starting

    expect(deps.saveHost).not.toHaveBeenCalled()
    expect(onHostUpdated).not.toHaveBeenCalled()
  })

  it('does not publish a rotated relay profile after stopping', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    let finishCredentialWrite: (() => void) | undefined
    const credentialWritePending = new Promise<void>((resolve) => {
      finishCredentialWrite = resolve
    })
    const writeBundle = vi
      .fn<(value: MobileRelayCredentialBundle) => Promise<void>>()
      .mockResolvedValue()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(credentialWritePending)
    const onHostUpdated = vi.fn()
    mockCredentialRotation(logical)
    const deps = dependencies({ writeBundle, onHostUpdated })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))
    supervisor.stop()
    finishCredentialWrite?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.saveHost).not.toHaveBeenCalled()
    expect(onHostUpdated).not.toHaveBeenCalled()
  })

  it('keeps a replacement-owned rotation durable across direct loss and restart', async () => {
    const rotatedBundle: MobileRelayCredentialBundle = {
      ...bundle,
      current: {
        token: 'C'.repeat(43),
        hash: 'D'.repeat(43),
        version: 3,
        expiresAt: Number.MAX_SAFE_INTEGER
      },
      grace: bundle.current
    }
    await writeMobileRelayCredentialBundle(bundle)

    let finishSecureWrite: (() => void) | null = null
    let markSecureWriteStarted: (() => void) | null = null
    const secureWriteStarted = new Promise<void>((resolve) => {
      markSecureWriteStarted = resolve
    })
    secureStoreMock.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      if (value === JSON.stringify(rotatedBundle)) {
        markSecureWriteStarted?.()
        await new Promise<void>((resolve) => {
          finishSecureWrite = resolve
        })
      }
      storedCredentialRaw = value
    })

    let markReplacementRecovered: (() => void) | null = null
    const replacementRecovered = new Promise<void>((resolve) => {
      markReplacementRecovered = resolve
    })
    const cleanupBundle = vi.fn(async (value: MobileRelayCredentialBundle) => {
      await replacementRecovered
      return deleteMobileRelayCredentialBundleIfCurrent(value)
    })
    const oldLifecycle = beginHostEndpointPublicationLifecycle(host.id)
    const oldWrite = writeExistingHostRelayCredentialBundle(
      host,
      rotatedBundle,
      writeMobileRelayCredentialBundle,
      oldLifecycle,
      cleanupBundle
    )
    await secureWriteStarted

    beginHostEndpointPublicationLifecycle(host.id)
    const replacementLogical = new FakeLogicalClient('disconnected', 'lan')
    const replacementOpenRelay = vi.fn(() => {
      markReplacementRecovered?.()
      return new FakeRelaySession('connected')
    })
    const replacement = new MobileEndpointSupervisor(
      replacementLogical,
      host,
      dependencies({ readBundle: readMobileRelayCredentialBundle, openRelay: replacementOpenRelay })
    )
    const replacementStart = replacement.start()

    finishSecureWrite?.()
    await expect(oldWrite).rejects.toBeInstanceOf(MobileRelayUpgradeLifecycleRetiredError)
    await replacementStart
    expect(replacementOpenRelay).toHaveBeenCalledWith(
      relay,
      expect.objectContaining({
        token: rotatedBundle.current.token,
        version: rotatedBundle.current.version
      }),
      expect.any(String)
    )
    replacement.stop()

    const restartedLogical = new FakeLogicalClient('disconnected', 'lan')
    const restartedOpenRelay = vi.fn(() => new FakeRelaySession('connected'))
    const restarted = new MobileEndpointSupervisor(
      restartedLogical,
      host,
      dependencies({ readBundle: readMobileRelayCredentialBundle, openRelay: restartedOpenRelay })
    )
    await restarted.start()

    expect(restartedOpenRelay).toHaveBeenCalledWith(
      relay,
      expect.objectContaining({
        token: rotatedBundle.current.token,
        version: rotatedBundle.current.version
      }),
      expect.any(String)
    )
    expect(JSON.parse(storedCredentialRaw ?? 'null')).toEqual(rotatedBundle)
    expect(cleanupBundle).not.toHaveBeenCalled()
    restarted.stop()
  })
})
