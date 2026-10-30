import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyConnection, type ConnectionVerdict } from './connection-health'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  bundle,
  dependencies,
  FakeRelaySession,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  createStableLogicalRpcClient,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Run beyond transient rejection windows through many escalating gated reprobes.
const FOUR_HOURS_MS = 4 * 60 * 60_000

function verdict(logical: StableLogicalRpcClient): ConnectionVerdict {
  return classifyConnection({
    state: logical.getState(),
    reconnectAttempts: logical.getReconnectAttempt(),
    lastConnectedAt: logical.getLastConnectedAt(),
    pendingPath: logical.getPendingPath(),
    pairingRejected: logical.isPairingRejected()
  })
}

describe('continuous Relay pairing-rejection escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-18T04:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  function harness(replacementFailure: Error, replacementsAfter = Number.POSITIVE_INFINITY) {
    const activeRelay = new FakeRelaySession('connected', new RelayOuterError(4408))
    activeRelay.getLastConnectedAt = () => Date.now() - 120_000
    const logical = createStableLogicalRpcClient(new FakeSession('disconnected'), 'tailscale')
    let replacements = 0
    const openRelay = vi.fn(() => {
      replacements += 1
      if (replacements > replacementsAfter) {
        return new FakeRelaySession('connected')
      }
      const session = new FakeRelaySession('connecting', replacementFailure)
      setTimeout(() => session.publishState('auth-failed'), 0)
      return session
    })
    openRelay.mockImplementationOnce(() => activeRelay)
    const readBundle = vi.fn(async () => bundle)
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay,
      readBundle,
      randomBytes: () => new Uint8Array([0, 0]),
      onLog: () => {}
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    return { activeRelay, logical, openRelay, supervisor }
  }

  it('escalates a persistent rejection to re-pair instead of "Connecting via Relay…"', async () => {
    const { activeRelay, logical, openRelay, supervisor } = harness(
      new MobileE2EEAuthenticationError()
    )

    await supervisor.start()
    expect(logical.getActivePath()).toBe('relay')
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)

    expect(openRelay.mock.calls.length).toBeGreaterThan(3)
    expect(logical.isPairingRejected()).toBe(true)
    expect(verdict(logical)).toMatchObject({
      kind: 'auth-failed',
      label: 'Pairing invalid — re-pair with your desktop'
    })
    supervisor.stop()
    logical.close()
  })

  it('escalates a relay-only phone rejected from its very first dial', async () => {
    const { logical, openRelay, supervisor } = harness(new MobileE2EEAuthenticationError())
    openRelay.mockReset()
    openRelay.mockImplementation(() => {
      const session = new FakeRelaySession('connecting', new MobileE2EEAuthenticationError())
      setTimeout(() => session.publishState('auth-failed'), 0)
      return session
    })

    // Run timers before awaiting start because its first dial fails.
    const started = supervisor.start()
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)
    await started

    expect(openRelay.mock.calls.length).toBeGreaterThan(3)
    expect(verdict(logical)).toMatchObject({ kind: 'auth-failed' })
    supervisor.stop()
    logical.close()
  })

  it('holds the verdict through a background/foreground cycle', async () => {
    const { activeRelay, logical, supervisor } = harness(new MobileE2EEAuthenticationError())

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)
    expect(logical.isPairingRejected()).toBe(true)

    // Resume changes retry cadence, not the desktop’s rejection evidence.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(logical.isPairingRejected()).toBe(true)
    expect(verdict(logical)).toMatchObject({ kind: 'auth-failed' })
    supervisor.stop()
    logical.close()
  })

  it('recovers a latched rejection through the manual app-resume nudge', async () => {
    const { activeRelay, logical, openRelay, supervisor } = harness(
      new MobileE2EEAuthenticationError()
    )

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)
    expect(logical.isPairingRejected()).toBe(true)

    openRelay.mockImplementation(() => new FakeRelaySession('connected'))
    supervisor.nudge('app-resume')
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay.mock.calls.length).toBeGreaterThan(3)
    expect(logical.getState()).toBe('connected')
    expect(logical.isPairingRejected()).toBe(false)
    supervisor.stop()
    logical.close()
  })

  it('never latches when the desktop accepts before the budget is spent', async () => {
    const { activeRelay, logical, supervisor } = harness(new MobileE2EEAuthenticationError(), 2)

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)

    expect(logical.isPairingRejected()).toBe(false)
    expect(logical.getActivePath()).toBe('relay')
    expect(verdict(logical)).toMatchObject({ kind: 'normal' })
    supervisor.stop()
    logical.close()
  })

  it('escalates inside a bounded window, and never on a brief blip', async () => {
    // Pin rejection cadence too; fast retry plus two jittered reprobes must tolerate transient post-pairing commits.
    const { activeRelay, logical, supervisor } = harness(new MobileE2EEAuthenticationError())

    await supervisor.start()
    activeRelay.publishState('disconnected')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.isPairingRejected()).toBe(false)

    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(logical.isPairingRejected()).toBe(true)
    supervisor.stop()
    logical.close()
  })

  it('clears the verdict end to end when the desktop accepts the pairing again', async () => {
    // Exercise supervisor success wiring so recovery actually clears the re-pair latch.
    const { activeRelay, logical, supervisor } = harness(new MobileE2EEAuthenticationError(), 4)

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(logical.isPairingRejected()).toBe(true)

    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)

    expect(logical.isPairingRejected()).toBe(false)
    expect(logical.getActivePath()).toBe('relay')
    expect(verdict(logical)).toMatchObject({ kind: 'normal' })
    supervisor.stop()
    logical.close()
  })

  it('never reports re-pair for a rejected relay credential', async () => {
    // Outer 4401 needs fresh credentials, not a pairing-revocation verdict.
    const { activeRelay, logical, supervisor } = harness(new RelayOuterError(4401))

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(FOUR_HOURS_MS)

    expect(logical.isPairingRejected()).toBe(false)
    expect(verdict(logical).kind).not.toBe('auth-failed')
    supervisor.stop()
    logical.close()
  })

  it('leaves a plain transport outage on the Relay-unreachable verdict', async () => {
    const { activeRelay, logical, supervisor } = harness(new RelayOuterError(4408))

    await supervisor.start()
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(logical.isPairingRejected()).toBe(false)
    expect(verdict(logical)).toMatchObject({
      kind: 'unreachable',
      label: "Can't connect via Relay"
    })
    supervisor.stop()
    logical.close()
  })
})
