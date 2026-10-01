import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))

vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEAuthenticationError: class extends Error {},
  MobileE2EEV2PhysicalChannel: class {
    start = vi.fn()
    handleMessage = vi.fn(async () => {})
    sendText = vi.fn(() => true)
    sendBinary = vi.fn(() => true)
    dispose = vi.fn()
  }
}))

import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import { classifyConnection } from './connection-health'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayDirectorHttpError } from './mobile-relay-resume-director'
import { relayHostReachabilityForFailure } from './relay-host-reachability-latch'
import type { RelayHostReachability } from './relay-host-reachability'

// Mirrors LogicalClientConnectionPath.update, the one consumer: it publishes
// only on change, so the latch itself need not dedupe.
function changesReportedTo(reported: RelayHostReachability[]) {
  let last: RelayHostReachability | null = null
  return (value: RelayHostReachability) => {
    if (value !== last) {
      last = value
      reported.push(value)
    }
  }
}

function controllerReportingTo(report: (reachability: RelayHostReachability) => void) {
  const controller = new RelayReconnectController(
    {
      now: () => 0,
      randomBytes: () => new Uint8Array([0, 0]),
      setTimer: () => 0,
      clearTimer: () => {}
    },
    () => {}
  )
  controller.reportRecoveryTo({
    setRecoveryAttempt: () => {},
    setPairingRejected: () => {},
    setRelayHostReachability: report
  })
  return controller
}

const hostOffline = () => new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE)

describe('relayHostReachabilityForFailure', () => {
  it('reads the cell close code off a failed dial', () => {
    expect(relayHostReachabilityForFailure(hostOffline())).toBe('host-offline')
    expect(
      relayHostReachabilityForFailure(
        new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)
      )
    ).toBe('credential-refused')
    expect(relayHostReachabilityForFailure(new RelayOuterError(1006))).toBe('unreachable')
  })

  it('treats a director 401 as the same refusal as a cell 4401', () => {
    expect(relayHostReachabilityForFailure(new RelayDirectorHttpError(401, null))).toBe(
      'credential-refused'
    )
    expect(relayHostReachabilityForFailure(new RelayDirectorHttpError(503, 30_000))).toBe(
      'connecting'
    )
  })

  it('has no verdict for errors that carry no relay code', () => {
    expect(relayHostReachabilityForFailure(new TypeError('Network request failed'))).toBe(
      'connecting'
    )
    expect(relayHostReachabilityForFailure(null)).toBe('connecting')
  })
})

describe('RelayReconnectController relay host reachability', () => {
  // The user's export: 25 dials over 25 h, every one relay_outer_4404, and the
  // row said "Connecting via Relay…" throughout. Two are enough to say why.
  it('reports host-offline on the second consecutive 4404, not the first', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReportingTo(changesReportedTo(reported))

    controller.registerFailure(hostOffline(), false)
    expect(reported).toEqual(['connecting'])

    controller.registerFailure(hostOffline(), false)
    expect(reported).toEqual(['connecting', 'host-offline'])
  })

  // The gate short-circuits registerFailure after a 4401; the verdict must be
  // banked before that return, exactly like the pairing-rejection latch.
  it('still latches credential-refused while the credential gate holds', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReportingTo(changesReportedTo(reported))
    const refused = () => new RelayOuterError(MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL)

    controller.registerFailure(refused(), false)
    controller.registerFailure(refused(), false)
    expect(reported.at(-1)).toBe('credential-refused')
  })

  it('ignores a failed replacement dial while an authenticated relay session is live', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReportingTo(changesReportedTo(reported))
    controller.registerFailure(hostOffline(), false)
    controller.setActiveSession({ getFailure: () => null })
    controller.registerFailure(hostOffline(), false)
    controller.registerFailure(hostOffline(), false)
    expect(reported).toEqual(['connecting'])
  })

  it('clears the verdict when a relay session authenticates', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReportingTo(changesReportedTo(reported))
    controller.registerFailure(hostOffline(), false)
    controller.registerFailure(hostOffline(), false)
    controller.setActiveSession({ getFailure: () => null })
    expect(reported).toEqual(['connecting', 'host-offline', 'connecting'])
  })

  it('clears the verdict when a direct session proves the desktop is up', () => {
    const reported: RelayHostReachability[] = []
    const controller = controllerReportingTo(changesReportedTo(reported))
    controller.registerFailure(new RelayOuterError(1006), false)
    controller.registerFailure(new RelayOuterError(1006), false)
    controller.resetForDirectConnection()
    expect(reported).toEqual(['connecting', 'unreachable', 'connecting'])
  })
})

describe('classifyConnection with a relay host verdict', () => {
  const base = {
    state: 'connecting' as const,
    reconnectAttempts: 1,
    lastConnectedAt: null,
    pendingPath: 'relay' as const,
    hostName: 'Host 1'
  }

  it('names the offline desktop instead of "Connecting via Relay…"', () => {
    expect(classifyConnection({ ...base, relayHostReachability: 'host-offline' })).toEqual({
      kind: 'unreachable',
      label: 'Host 1 is offline',
      reason: 'never-connected',
      detail: "Check it's awake, Orca is running, and you're signed in"
    })
  })

  it('names the refused credential and its real remedy, not a desktop sign-in', () => {
    expect(classifyConnection({ ...base, relayHostReachability: 'credential-refused' })).toEqual({
      kind: 'unreachable',
      label: 'Relay access expired for Host 1',
      reason: 'never-connected',
      detail: 'Re-pair with your desktop'
    })
  })

  // Amber, not red: a transport close says nothing about the desktop.
  it('blames the connection, softly, on a transport close', () => {
    expect(classifyConnection({ ...base, relayHostReachability: 'unreachable' })).toEqual({
      kind: 'warning',
      label: "Can't reach Relay",
      detail: 'Check your connection'
    })
  })

  it('keeps narrating Relay while the verdict is still connecting', () => {
    expect(classifyConnection({ ...base, relayHostReachability: 'connecting' }).label).toBe(
      'Connecting via Relay…'
    )
  })

  // A 4401 clears the relay recovery path; the direct retry loop must not hide it.
  it('does not depend on the relay path still being pending', () => {
    expect(
      classifyConnection({
        ...base,
        state: 'reconnecting',
        pendingPath: null,
        relayHostReachability: 'credential-refused'
      }).label
    ).toBe('Relay access expired for Host 1')
  })

  it('reads as stale once this session had been connected', () => {
    expect(
      classifyConnection({
        ...base,
        lastConnectedAt: 1,
        nowMs: 2,
        relayHostReachability: 'host-offline'
      })
    ).toMatchObject({ reason: 'stale' })
  })

  it('falls back to a generic host name', () => {
    expect(
      classifyConnection({ ...base, hostName: undefined, relayHostReachability: 'host-offline' })
        .label
    ).toBe('Host is offline')
  })

  it('never appends the Tailscale hint', () => {
    expect(
      classifyConnection({ ...base, endpoint: '100.64.0.1', relayHostReachability: 'host-offline' })
    ).not.toHaveProperty('hint')
  })

  it('yields to a revoked pairing and a live connection', () => {
    expect(
      classifyConnection({ ...base, pairingRejected: true, relayHostReachability: 'host-offline' })
        .kind
    ).toBe('auth-failed')
    expect(
      classifyConnection({ ...base, state: 'connected', relayHostReachability: 'host-offline' })
        .label
    ).toBe('Connected')
  })
})
