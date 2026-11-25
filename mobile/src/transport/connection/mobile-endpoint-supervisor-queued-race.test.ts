import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import {
  FakeLogicalClient,
  FakeRelaySession,
  bundle,
  dependencies,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('../../host-credentials/pairing-keychain', () => ({
  deletePairingKeychainItem: vi.fn(),
  readPairingKeychainItem: vi.fn(),
  writePairingKeychainItem: vi.fn()
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

type OpenRelayFn = MobileEndpointSupervisorDependencies['openRelay']
type OpenRelay = Mock<OpenRelayFn>

type Harness = {
  logical: FakeLogicalClient
  supervisor: MobileEndpointSupervisor
  openRelay: OpenRelay
  onLog: Mock<ConnectionLogSink>
  started: Promise<void>
  releaseKeychain: () => void
}

// Off the home network: the direct client redials a Tailscale address that never answers, and the
// cold-start read misses, so recovery re-reads the keychain under the mutex. While that read is
// pending, direct starts its next dial and the grace timer queues a forced race behind the read.
async function queueRaceBehindKeychainRead(
  openRelay: OpenRelay = vi.fn<OpenRelayFn>(() => new FakeRelaySession('connected'))
): Promise<Harness> {
  const logical = new FakeLogicalClient('reconnecting', 'tailscale')
  let release: (value: MobileRelayCredentialBundle) => void = () => {}
  const readBundle = vi
    .fn<() => Promise<MobileRelayCredentialBundle | null>>()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(
      () => new Promise<MobileRelayCredentialBundle>((resolve) => (release = resolve))
    )
    .mockResolvedValue(bundle)
  const onLog = vi.fn<ConnectionLogSink>()
  const supervisor = new MobileEndpointSupervisor(
    logical,
    host.id,
    relay,
    dependencies({ readBundle, openRelay, onLog, directPath: 'tailscale' })
  )
  const started = supervisor.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readBundle).toHaveBeenCalledTimes(2)
  logical.publishState('connecting')
  await vi.advanceTimersByTimeAsync(2_500)
  return {
    logical,
    supervisor,
    openRelay,
    onLog,
    started,
    releaseKeychain: () => release(bundle)
  }
}

describe('direct-grace race queued behind relay recovery', () => {
  afterEach(() => vi.useRealTimers())

  it('dials Relay once an operation that skipped its dial releases the mutex', async () => {
    vi.useFakeTimers()
    const { logical, supervisor, openRelay, started, releaseKeychain } =
      await queueRaceBehindKeychainRead()
    try {
      releaseKeychain()
      await started
      await vi.advanceTimersByTimeAsync(0)

      expect(openRelay).toHaveBeenCalledTimes(1)
      expect(logical.getActivePath()).toBe('relay')
      expect(logical.getState()).toBe('connected')
    } finally {
      supervisor.stop()
    }
  })

  it("leaves a race queued behind a failed dial to that dial's booked retry", async () => {
    vi.useFakeTimers()
    const openRelay = vi.fn<OpenRelayFn>(
      () => new FakeRelaySession('disconnected', new Error('relay closed'))
    )
    const { logical, supervisor, onLog, started, releaseKeychain } =
      await queueRaceBehindKeychainRead(openRelay)
    try {
      // Direct fails again, so the operation still needs Relay and dials it.
      logical.publishState('reconnecting')
      releaseKeychain()
      await started
      await vi.advanceTimersByTimeAsync(0)

      expect(openRelay).toHaveBeenCalled()
      // No replay ran into the cooldown the failure booked.
      const messages = onLog.mock.calls.map(([entry]) => entry.message)
      expect(messages.filter((message) => message.includes('recovery deferred'))).toEqual([])
    } finally {
      supervisor.stop()
    }
  })

  it('drops the queued race when the supervisor stops mid-operation', async () => {
    vi.useFakeTimers()
    const { supervisor, openRelay, started, releaseKeychain } = await queueRaceBehindKeychainRead()
    supervisor.stop()
    releaseKeychain()
    await started
    await vi.advanceTimersByTimeAsync(10_000)
    expect(openRelay).not.toHaveBeenCalled()
  })

  it('drops the queued race when the app backgrounds mid-operation', async () => {
    vi.useFakeTimers()
    const { supervisor, openRelay, started, releaseKeychain } = await queueRaceBehindKeychainRead()
    try {
      supervisor.setForeground(false)
      releaseKeychain()
      await started
      await vi.advanceTimersByTimeAsync(0)
      expect(openRelay).not.toHaveBeenCalled()
    } finally {
      supervisor.stop()
    }
  })

  it('books a socket constructor throw in the replayed dial as a failed dial', async () => {
    vi.useFakeTimers()
    const openRelay = vi
      .fn<OpenRelayFn>()
      .mockImplementationOnce(() => {
        throw new Error('socket constructor failed')
      })
      .mockImplementation(() => new FakeRelaySession('connected'))
    const { logical, supervisor, started, releaseKeychain } =
      await queueRaceBehindKeychainRead(openRelay)
    try {
      releaseKeychain()
      await started
      await vi.advanceTimersByTimeAsync(0)
      // The throw is a failed candidate, not a rejected recovery: the next candidate dials and connects.
      expect(openRelay.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(logical.getActivePath()).toBe('relay')
      expect(logical.getState()).toBe('connected')
    } finally {
      supervisor.stop()
    }
  })
})
