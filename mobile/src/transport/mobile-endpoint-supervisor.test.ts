import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  mockCredentialRotation,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails over to a confirmed relay session and persists its renewed expiry', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeRelaySession),
      'relay',
      undefined,
      expect.any(Function)
    )
    expect(logical.getActivePath()).toBe('relay')
    expect(deps.writeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ current: expect.objectContaining({ version: 2 }) })
    )
    supervisor.stop()
  })

  it('does not spend a queued relay retry while direct authentication is progressing', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('handshaking')
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })

  it('uses POST resolve for wrong-cell recovery and persists the authoritative target', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const resolved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
    const deps = dependencies({
      openRelay,
      resolveRelay: vi.fn(async () => resolved)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()

    expect(deps.resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenLastCalledWith(
      resolved,
      expect.any(Object),
      expect.any(String),
      expect.any(Function)
    )
    expect(deps.setRelayRouting).toHaveBeenCalledWith(host.id, resolved)
    supervisor.stop()
  })

  it('promotes direct only after repeated foreground authenticated probes and dwell', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(45_000)
    expect(logical.getActivePath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(deps.openDirect).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })

  it('recovers the relay when it drops during an unavailable direct probe', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openDirect: vi.fn(() => direct),
      openRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    // Drop relay while the direct probe holds the mutex; failed probes must replay deferred relay recovery.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    direct.publishState('disconnected')

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    supervisor.stop()
  })

  it('escalates backoff when relay sessions connect and then drop repeatedly', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(2)

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(499)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(999)
    expect(openRelay).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })

  it('does not try a grace credential for a capacity failure before backing off', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4429)))
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('does not redial a rejected current credential on grace cooldown retries', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(
      (_relay, credential: { version: number }) =>
        new FakeRelaySession(
          'disconnected',
          new RelayOuterError(credential.version === bundle.current.version ? 4401 : 4429)
        )
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(openRelay.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ version: 1 }))
    supervisor.stop()
  })

  it('keeps an authenticated relay off the backoff path when persistence fails', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      writeBundle: vi.fn(async () => {
        throw new Error('secure store unavailable')
      })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })

  it('recovers a relay drop while post-migration persistence owns the mutex', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', new RelayOuterError(4408)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      writeBundle: vi.fn(() => writePending),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    logical.publishState('disconnected')
    finishWrite?.()
    await starting

    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('keeps rejected relay credentials gated until their replacement is durable', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    let finishCredentialWrite: (() => void) | undefined
    const credentialWritePending = new Promise<void>((resolve) => {
      finishCredentialWrite = resolve
    })
    const writeBundle = vi
      .fn<(value: MobileRelayCredentialBundle) => Promise<void>>()
      .mockResolvedValue()
      .mockResolvedValueOnce()
      .mockReturnValueOnce(credentialWritePending)
    mockCredentialRotation(logical)
    const deps = dependencies({ openRelay, writeBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))

    // The direct socket can disappear after the server commits but before the
    // replacement credential finishes its durable write.
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    finishCredentialWrite?.()
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 3 }),
      expect.any(String),
      expect.any(Function)
    )
    supervisor.stop()
  })

  it('uses a scheduled credential rotation that finishes after relay rejection', async () => {
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
    mockCredentialRotation(logical)
    const openRelay = vi.fn(
      (_relay, credential: { version: number }) =>
        new FakeRelaySession(
          credential.version === bundle.current.version ? 'disconnected' : 'connected',
          credential.version === bundle.current.version ? new RelayOuterError(4401) : null
        )
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        current: { ...bundle.current, expiresAt: Date.now() + 60_000 }
      })),
      openRelay,
      writeBundle
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledTimes(2))

    // The expiring credential can be rejected while its replacement is waiting on SecureStore.
    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    finishCredentialWrite?.()

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 3 }),
      expect.any(String),
      expect.any(Function)
    )
    supervisor.stop()
  })

  it('does not open a resolved relay replacement after backgrounding', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishResolve: ((value: typeof relay) => void) | undefined
    const resolvePending = new Promise<typeof relay>((resolve) => {
      finishResolve = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      resolveRelay: vi.fn(() => resolvePending)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishResolve?.(relay)
    await starting

    expect(openRelay).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not recreate a lease timer after stop races relay persistence', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishWrite: (() => void) | undefined
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const deps = dependencies({ writeBundle: vi.fn(() => writePending) })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    supervisor.stop()
    finishWrite?.()
    await starting

    expect(vi.getTimerCount()).toBe(0)
  })

  it('skips forced rotation for a session resumed without renewal', async () => {
    // An unrenewed lease keeps its deadline; rotating again would churn replacements at every clamp floor.
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(
      () => new FakeRelaySession('connected', null, Date.now() + 31_000, false)
    )
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected'))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(openRelay).toHaveBeenCalledTimes(1)
    supervisor.stop()
  })

  it('keeps a fatal lease-replacement gate after the active relay later drops', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('connected', new RelayOuterError(4408), Date.now() + 31_000)
      )
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    // The old relay can outlive its rejected lease replacement, then close separately.
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('races a relay dial when the direct dial stalls unauthenticated', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(2_499)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connecting')

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))
    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeRelaySession),
      'relay',
      undefined,
      expect.any(Function)
    )
    supervisor.stop()
  })

  it('cancels the grace race when the direct dial authenticates first', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    logical.publishState('connected')
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('drops the pending grace race when the phone backgrounds', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })
})
