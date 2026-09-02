import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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

  it('fails over when the direct retry loop publishes reconnecting', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('handshaking')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))

    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeRelaySession),
      'relay',
      undefined,
      expect.any(Function)
    )
    supervisor.stop()
  })

  it('fails over when direct is already reconnecting before startup completes', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeRelaySession),
      'relay',
      undefined,
      expect.any(Function)
    )
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('does not announce Relay when credential selection finishes after backgrounding', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    let finishCredentialRead: ((value: MobileRelayCredentialBundle) => void) | undefined
    const credentialReadPending = new Promise<MobileRelayCredentialBundle>((resolve) => {
      finishCredentialRead = resolve
    })
    const readBundle = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(credentialReadPending)
    const deps = dependencies({ readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(readBundle).toHaveBeenCalledTimes(2))
    supervisor.setForeground(false)
    finishCredentialRead?.(bundle)
    await starting

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.setRecoveryPath).not.toHaveBeenCalledWith('relay')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })

  it('does not announce Relay without a dialable credential', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const expired = { ...bundle, current: { ...bundle.current, expiresAt: Date.now() - 1 } }
    const deps = dependencies({ readBundle: vi.fn(async () => expired) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.setRecoveryPath).not.toHaveBeenCalledWith('relay')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })

  it('keeps Relay pending through a failed dial cooldown and clears it on stop', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const deps = dependencies({
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408))),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.getPendingPath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(249)
    expect(logical.getPendingPath()).toBe('relay')

    supervisor.stop()
    expect(logical.getPendingPath()).toBeNull()
  })

  it('does not spend a queued relay retry while direct authentication is progressing', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenLastCalledWith(resolved, expect.any(Object), expect.any(String))
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({ relay: resolved, endpoint: host.endpoint })
    )
    supervisor.stop()
  })

  it('promotes direct only after repeated foreground authenticated probes and dwell', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    // Start the probe, then drop the active relay while the probe owns the
    // operation mutex. The failed probe must hand recovery back to the relay.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    direct.publishState('disconnected')

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    supervisor.stop()
  })

  it('backs off a close from the active relay before opening its replacement', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', new RelayOuterError(4429)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const onLog = vi.fn()
    const deps = dependencies({
      openRelay,
      onLog,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('disconnected')

    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getPendingPath()).toBe('relay')
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'relay-session-failed',
        path: 'relay',
        message: 'Relay: active relay session failed'
      })
    )
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('does not announce recovery when an active Relay drops after credential expiry', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const expired = { ...bundle, current: { ...bundle.current, expiresAt: Date.now() - 1 } }
    const deps = dependencies({ readBundle: vi.fn(async () => expired) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.setRecoveryPath).not.toHaveBeenCalledWith('relay')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })

  it('escalates backoff when relay sessions connect and then drop repeatedly', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(openRelay.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ version: 1 }))
    supervisor.stop()
  })

  it('rotates a rejected current credential after grace keeps relay recovery alive', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const current = {
      ...bundle.current,
      hash: hashMobileRelayCredential(bundle.current.token)
    }
    const writeBundle = vi.fn(async () => {})
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        current,
        grace: { ...current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay: vi.fn(
        (_relay, credential: { version: number }) =>
          new FakeRelaySession(
            credential.version === current.version ? 'disconnected' : 'connected',
            credential.version === current.version ? new RelayOuterError(4401) : null
          )
      ),
      writeBundle
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    writeBundle.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(writeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ pending: expect.any(Object) })
    )
    supervisor.stop()
  })

  it('does not duplicate transport failures across current and grace credentials', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new Error('network down')))
    const resolveRelay = vi.fn(async () => {
      throw new Error('director unreachable')
    })
    const deps = dependencies({
      readBundle: vi.fn(async () => ({
        ...bundle,
        grace: { ...bundle.current, token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1 }
      })),
      openRelay,
      resolveRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    expect(resolveRelay).toHaveBeenCalledOnce()
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })

  it('cancels a pending relay retry when the original direct path reconnects', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408))),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(vi.getTimerCount()).toBe(1)

    logical.publishState('connected')
    expect(vi.getTimerCount()).toBe(0)
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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

  it('retries a host-offline relay without requiring an external signal', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4404)))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    supervisor.stop()
  })

  it('waits for direct connectivity before replacing a rejected relay credential', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4401)))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(1000)

    expect(openRelay).toHaveBeenCalledOnce()
    expect(deps.writeBundle).not.toHaveBeenCalled()
    expect(logical.getPendingPath()).toBeNull()

    logical.publishState('connected')
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
      expect.any(String)
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
      expect.any(String)
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishResolve?.(relay)
    await starting

    expect(openRelay).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not recreate a lease retry after forced replacement is backgrounded', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let finishResolve: ((value: typeof relay) => void) | undefined
    const resolvePending = new Promise<typeof relay>((resolve) => {
      finishResolve = resolve
    })
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      resolveRelay: vi.fn(() => resolvePending)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishResolve?.(relay)
    await vi.waitFor(() => expect(deps.saveHost).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledTimes(2)
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())
    supervisor.stop()
    finishWrite?.()
    await starting

    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not poll a host-offline relay through forced lease retries', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockImplementation(() => new FakeRelaySession('disconnected', new RelayOuterError(4404)))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected'))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('skips forced rotation for a session resumed without renewal', async () => {
    // Why: renewed=false means a re-resume provably returns the same unchanged
    // deadline; rotating anyway churned one session replacement per clamp floor.
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(
      () => new FakeRelaySession('connected', null, Date.now() + 31_000, false)
    )
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected'))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    // The old relay can outlive its rejected lease replacement, then close separately.
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('keeps revival nudges inside a failed lease rotation cooldown', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4429)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    // A network nudge inside the cooldown must not dial early and must not tear
    // down the healthy session; the queued intent runs at the 250 ms boundary.
    supervisor.nudge('network-change')
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('keeps lease rotation inside an active relay failure cooldown', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('connected', new RelayOuterError(4429), Date.now() + 31_000)
      )
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(900)
    logical.publishState('disconnected')

    await vi.advanceTimersByTimeAsync(100)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(150)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('clears relay backoff on a genuine foreground so the retry is immediate', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    const afterStart = openRelay.mock.calls.length

    // Background → foreground is a fresh signal: dial now, not after the cooldown.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay.mock.calls.length).toBeGreaterThan(afterStart)
    supervisor.stop()
  })

  it('races a relay dial when the direct dial stalls unauthenticated', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(2_499)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connecting')

    // The direct dial never authenticates; the relay wins the race through migrateTo.
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('never races a relay dial against a desktop with no relay endpoint', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, { ...host, relay: undefined }, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('drops the pending grace race when the phone backgrounds', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('books the shared cooldown when the grace race loses its dial', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({ openRelay, randomBytes: () => new Uint8Array([128, 0]) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(openRelay).toHaveBeenCalledOnce()

    // The armed retry runs unforced, so it yields to the still-progressing direct
    // dial: the race gets one attempt, never a socket-per-cooldown loop.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledOnce()

    // Direct finally gives up: ordinary recovery still owns the failure.
    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    supervisor.stop()
  })
})
