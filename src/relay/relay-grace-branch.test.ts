import { describe, expect, it } from 'vitest'
import { decideRelayGrace, type RelayGraceDecisionInput } from './relay-grace-branch'

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
