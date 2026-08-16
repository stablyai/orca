import { describe, expect, it, vi } from 'vitest'
import {
  applyRelayGraceTimeConfiguration,
  decideRelayGrace,
  decideRelayGraceReconfigure,
  type RelayGraceBranch,
  type RelayGraceDecisionInput,
  type RelayGraceReconfigureInput
} from './relay-grace-branch'

const EMPTY_DETACHED_STARTUP_GRACE_MS = 30_000
const IDLE_RELAY_GRACE_MS = 15 * 60_000

function decide(overrides: Partial<RelayGraceDecisionInput> = {}) {
  return decideRelayGrace({
    configuredGraceMs: 0,
    relayIdle: false,
    detached: false,
    hasAcceptedSocketClient: true,
    activePtyCount: 1,
    retryDeferredShutdown: false,
    emptyDetachedStartupGraceMs: EMPTY_DETACHED_STARTUP_GRACE_MS,
    idleRelayGraceMs: IDLE_RELAY_GRACE_MS,
    ...overrides
  })
}

describe('decideRelayGrace', () => {
  describe('the zero-only gate', () => {
    it('honors a grace raised after launch instead of clamping it to the idle cap', () => {
      // Why: the reported bug. startGrace used to read the launch-time argv closure, so a host that
      // raised the grace to 24h via relay.configureGraceTime still got the 15-minute idle cap.
      expect(decide({ configuredGraceMs: 86_400_000, relayIdle: true, activePtyCount: 0 })).toEqual(
        {
          branch: 'configured',
          timeoutMs: 86_400_000
        }
      )
    })

    it('caps an idle relay running the unlimited default at the idle grace', () => {
      // Why: prepareForHostSleep notifies graceTimeSeconds:0, which now reaches this selector.
      // Deliberate behavior change: a host-sleep relay holding zero PTYs exits after the idle cap
      // instead of living forever. Pinned so the revived path stays a decision, not an accident.
      expect(decide({ configuredGraceMs: 0, relayIdle: true, activePtyCount: 0 })).toEqual({
        branch: 'idle-no-ptys',
        timeoutMs: IDLE_RELAY_GRACE_MS
      })
    })

    it('leaves a non-idle relay on the configured branch even at the unlimited default', () => {
      // Why: an admitted-but-unpooled creation keeps relayIdle false, so the cap must not apply —
      // it would kill the shell that creation is about to produce (#6955).
      expect(decide({ configuredGraceMs: 0, relayIdle: false })).toEqual({
        branch: 'configured',
        timeoutMs: 0
      })
    })
  })

  describe('branch precedence', () => {
    it('prefers shutdown-deferred over every other branch', () => {
      expect(
        decide({
          retryDeferredShutdown: true,
          detached: true,
          hasAcceptedSocketClient: false,
          relayIdle: true,
          activePtyCount: 0
        })
      ).toEqual({ branch: 'shutdown-deferred', timeoutMs: IDLE_RELAY_GRACE_MS })
    })

    it('prefers startup-empty-detached over the idle cap', () => {
      expect(
        decide({
          detached: true,
          hasAcceptedSocketClient: false,
          relayIdle: true,
          activePtyCount: 0
        })
      ).toEqual({ branch: 'startup-empty-detached', timeoutMs: EMPTY_DETACHED_STARTUP_GRACE_MS })
    })

    it('bounds a configured grace on the startup-empty-detached branch', () => {
      expect(
        decide({
          configuredGraceMs: 5_000,
          detached: true,
          hasAcceptedSocketClient: false,
          activePtyCount: 0
        })
      ).toEqual({ branch: 'startup-empty-detached', timeoutMs: 5_000 })
    })

    it('does not treat a detached relay that already accepted a client as startup-empty', () => {
      expect(
        decide({
          detached: true,
          hasAcceptedSocketClient: true,
          relayIdle: true,
          activePtyCount: 0
        })
      ).toEqual({ branch: 'idle-no-ptys', timeoutMs: IDLE_RELAY_GRACE_MS })
    })
  })
})

function reconfigure(overrides: Partial<RelayGraceReconfigureInput> = {}) {
  return decideRelayGraceReconfigure({
    previousConfiguredGraceMs: 10_000,
    nextConfiguredGraceMs: 86_400_000,
    graceTimerArmed: true,
    shutdownInFlight: false,
    currentBranch: 'configured',
    ...overrides
  })
}

describe('decideRelayGraceReconfigure', () => {
  it('re-arms a running window so a raised grace takes effect at the new deadline', () => {
    // Why: the reported bug's call site. startGrace samples the grace at arm time, so without this
    // re-arm a raise landing mid-window still fires at the old deadline.
    expect(reconfigure()).toEqual({ rearm: true, retryDeferredShutdown: false })
  })

  it('preserves shutdown-deferred across the re-arm', () => {
    const rearmed = reconfigure({ nextConfiguredGraceMs: 0, currentBranch: 'shutdown-deferred' })

    expect(rearmed).toEqual({ rearm: true, retryDeferredShutdown: true })
    expect(
      decide({
        configuredGraceMs: 0,
        retryDeferredShutdown: rearmed.rearm && rearmed.retryDeferredShutdown
      })
    ).toEqual({ branch: 'shutdown-deferred', timeoutMs: IDLE_RELAY_GRACE_MS })
  })

  it('ignores a re-assertion of the same grace', () => {
    // Why: the host re-asserts its grace on every establish; re-arming on those would keep the
    // window alive indefinitely.
    expect(reconfigure({ previousConfiguredGraceMs: 86_400_000 })).toEqual({ rearm: false })
  })

  it('does not arm a window that was never running', () => {
    expect(reconfigure({ graceTimerArmed: false })).toEqual({ rearm: false })
  })

  it('does not re-arm once shutdown is in flight', () => {
    expect(reconfigure({ shutdownInFlight: true })).toEqual({ rearm: false })
  })
})

/**
 * Models relay.ts's grace state around the configureGraceTime call site: `startGrace` re-decides the
 * branch exactly as the relay does, so a dropped `retryDeferredShutdown` shows up as a branch downgrade.
 */
function relayGraceHost(
  overrides: {
    configuredGraceMs?: number
    graceTimerArmed?: boolean
    shutdownInFlight?: boolean
    graceBranch?: RelayGraceBranch | null
    relayIdle?: boolean
    activePtyCount?: number
  } = {}
) {
  let configuredGraceMs = overrides.configuredGraceMs ?? 10_000
  let graceBranch: RelayGraceBranch | null = overrides.graceBranch ?? 'configured'
  const startGrace = vi.fn(
    (_reason: string, options?: { retryDeferredShutdown?: boolean }): void => {
      graceBranch = decide({
        configuredGraceMs,
        relayIdle: overrides.relayIdle ?? true,
        activePtyCount: overrides.activePtyCount ?? 0,
        retryDeferredShutdown: options?.retryDeferredShutdown === true
      }).branch
    }
  )

  return {
    startGrace,
    branch: () => graceBranch,
    configuredGraceMs: () => configuredGraceMs,
    apply: (graceTimeSeconds: unknown) =>
      applyRelayGraceTimeConfiguration(graceTimeSeconds, {
        readConfiguredGraceMs: () => configuredGraceMs,
        // Mirrors PtyHandler.setGraceTimeMs's clamp so the decision sees the stored value.
        writeConfiguredGraceMs: (graceMs) => {
          configuredGraceMs = Math.max(0, Math.floor(graceMs))
        },
        isGraceTimerArmed: () => overrides.graceTimerArmed ?? true,
        isShutdownInFlight: () => overrides.shutdownInFlight ?? false,
        readGraceBranch: () => graceBranch,
        startGrace
      })
  }
}

describe('applyRelayGraceTimeConfiguration', () => {
  it('re-arms a deferred shutdown without downgrading it to an ordinary configured window', () => {
    // Why: the call site the branch selector alone cannot cover — dropping the startGrace option here
    // would leave a refused kill with nothing left to retry it.
    const host = relayGraceHost({ graceBranch: 'shutdown-deferred', configuredGraceMs: 0 })

    expect(host.apply(86_400)).toEqual({ graceTimeMs: 86_400_000 })
    expect(host.startGrace).toHaveBeenCalledWith('grace reconfigured', {
      retryDeferredShutdown: true
    })
    expect(host.branch()).toBe('shutdown-deferred')
  })

  it('re-arms an ordinary window at the raised grace', () => {
    const host = relayGraceHost()

    expect(host.apply(86_400)).toEqual({ graceTimeMs: 86_400_000 })
    expect(host.startGrace).toHaveBeenCalledWith('grace reconfigured', {
      retryDeferredShutdown: false
    })
    expect(host.branch()).toBe('configured')
  })

  it('stores the host-sleep zero and lets the idle cap own the window', () => {
    const host = relayGraceHost()

    expect(host.apply(0)).toEqual({ graceTimeMs: 0 })
    expect(host.startGrace).toHaveBeenCalledTimes(1)
    expect(host.branch()).toBe('idle-no-ptys')
  })

  it('does not re-arm on a re-asserted grace', () => {
    const host = relayGraceHost({ configuredGraceMs: 86_400_000 })

    expect(host.apply(86_400)).toEqual({ graceTimeMs: 86_400_000 })
    expect(host.startGrace).not.toHaveBeenCalled()
  })

  it('does not arm a window that was never running', () => {
    const host = relayGraceHost({ graceTimerArmed: false })

    expect(host.apply(86_400)).toEqual({ graceTimeMs: 86_400_000 })
    expect(host.startGrace).not.toHaveBeenCalled()
  })

  it('ignores a malformed or negative payload without touching the stored grace', () => {
    for (const payload of [undefined, 'later', Number.NaN, -1]) {
      const host = relayGraceHost()

      expect(host.apply(payload)).toEqual({ graceTimeMs: 10_000 })
      expect(host.configuredGraceMs()).toBe(10_000)
      expect(host.startGrace).not.toHaveBeenCalled()
    }
  })
})
