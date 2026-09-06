import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyConnection, type ConnectionVerdict } from './connection-health'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  bundle,
  dependencies,
  FakeRelaySession,
  FakeSession,
  host
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

// Why: 12+ gated reprobe ticks (45s escalating to the 675s floored ceiling) — long
// past any transient post-pairing rejection, which is the window under test.
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

  // Establishes Relay through the supervisor, then fails every replacement dial.
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
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

    // Pre-fix, the gate suppressed the failure count so this stalled on
    // "Connecting via Relay…" for every one of these dials (STA-4681).
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

    // Why: the first dial fails, so start() only settles once fake timers run.
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

    // Why: an app resume resets the retry cadence, but it is not evidence the
    // desktop changed its mind — pre-fix this walked the count backwards.
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

    // Two transient rejections while the desktop commits credentials, then success.
    expect(logical.isPairingRejected()).toBe(false)
    expect(logical.getActivePath()).toBe('relay')
    expect(verdict(logical)).toMatchObject({ kind: 'normal' })
    supervisor.stop()
    logical.close()
  })

  it('escalates inside a bounded window, and never on a brief blip', async () => {
    // Why: the budget is only meaningful with a cadence. Three rejections cost one fast
    // transport retry plus two gated reprobes (60s and 120s bases, jittered 0.75-1.25x),
    // so the floor is ~2m15s and the ceiling ~3m45s in production.
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
    // Why: the unit tests clear the latch through controller methods directly. If the
    // supervisor's success wiring regressed, a re-paired phone would stay on "re-pair"
    // forever with every other assertion still green.
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
    // Why: a 4401 close enters the fresh-credential gate, not the pairing-rejection
    // path. It is repaired by credential rotation, so it must not accuse the pairing.
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
