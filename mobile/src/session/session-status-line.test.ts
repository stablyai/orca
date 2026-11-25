import { describe, expect, it } from 'vitest'
import type { ConnectionVerdict } from '../transport/connection/connection-health'
import {
  sessionConnectionVerdict,
  sessionRetryAvailable,
  sessionStatusDot,
  sessionStatusLine,
  type SessionConnectionVerdictInputs
} from './session-connection-verdict'

const NOW = 1_000_000_000

function verdict(overrides: Partial<SessionConnectionVerdictInputs> = {}): ConnectionVerdict {
  return sessionConnectionVerdict({
    state: 'reconnecting',
    reconnectAttempts: 5,
    lastConnectedAt: NOW - 5 * 60_000,
    endpoint: 'ws://100.101.102.103:6768',
    hostName: 'Work laptop',
    pendingPath: null,
    pairingRejected: false,
    relayHostReachability: 'connecting',
    nowMs: NOW,
    ...overrides
  })
}

// The hook passes sessionRetryAvailable as retryShown; with canReconnect the line mirrors it.
function line(
  overrides: Partial<SessionConnectionVerdictInputs> = {},
  presentedConnState: SessionConnectionVerdictInputs['state'] = 'reconnecting',
  canReconnect = false
) {
  const current = verdict(overrides)
  return sessionStatusLine({
    verdict: current,
    presentedConnState,
    pendingPath: overrides.pendingPath ?? null,
    retryShown: sessionRetryAvailable(current, canReconnect)
  })
}

describe('sessionStatusLine', () => {
  it('names a Relay dial instead of the generic reconnecting label', () => {
    expect(line({ pendingPath: 'relay', reconnectAttempts: 1 })).toEqual({
      label: 'Connecting via Relay…',
      withRetrySuffix: false
    })
  })

  it('keeps the generic label for a direct redial with no verdict yet', () => {
    expect(line({ reconnectAttempts: 1 }, 'handshaking')).toEqual({
      label: 'Securing',
      withRetrySuffix: false
    })
  })

  it('shows a refused pairing during a raw reconnect, with no retry offer', () => {
    expect(line({ pairingRejected: true }, 'reconnecting', true)).toEqual({
      label: 'Pairing invalid — re-pair with your desktop',
      withRetrySuffix: false
    })
  })

  it('shows Relay error verdicts through the calm window', () => {
    // A calmed drop still reads connected, but an explicit Relay verdict is not a short drop.
    expect(line({ relayHostReachability: 'host-offline' }, 'connected')).toEqual({
      label: 'Work laptop is offline',
      withRetrySuffix: false
    })
    expect(line({ pairingRejected: true }, 'connected')?.label).toBe(
      'Pairing invalid — re-pair with your desktop'
    )
  })

  it('keeps the place label while a calmed drop has no error verdict', () => {
    expect(line({ reconnectAttempts: 1 }, 'connected')).toBeNull()
    expect(line({ pendingPath: 'relay', reconnectAttempts: 1 }, 'connected')).toBeNull()
  })

  it('offers retry on outages, but not when Relay refused the credential', () => {
    expect(line({ relayHostReachability: 'host-offline' }, 'reconnecting', true)).toEqual({
      label: 'Work laptop is offline',
      withRetrySuffix: true
    })
    expect(line({ relayHostReachability: 'credential-refused' }, 'reconnecting', true)).toEqual({
      label: 'Relay refused access for Work laptop',
      withRetrySuffix: false
    })
  })
})

describe('sessionRetryAvailable', () => {
  it('offers a redial for outages only, never for a refused pairing or Relay credential', () => {
    expect(sessionRetryAvailable(verdict({ relayHostReachability: 'host-offline' }), true)).toBe(
      true
    )
    expect(sessionRetryAvailable(verdict({ relayHostReachability: 'unreachable' }), true)).toBe(
      true
    )
    expect(
      sessionRetryAvailable(verdict({ relayHostReachability: 'credential-refused' }), true)
    ).toBe(false)
    expect(sessionRetryAvailable(verdict({ pairingRejected: true }), true)).toBe(false)
    expect(sessionRetryAvailable(verdict({ reconnectAttempts: 1 }), true)).toBe(false)
    expect(sessionRetryAvailable(verdict({ relayHostReachability: 'host-offline' }), false)).toBe(
      false
    )
  })
})

describe('sessionStatusDot', () => {
  it('colours by the verdict unless a short drop is calmed', () => {
    const dialing = verdict({ reconnectAttempts: 1 })
    expect(
      sessionStatusDot({
        verdict: dialing,
        connState: 'reconnecting',
        presentedConnState: 'connected'
      })
    ).toEqual({ state: 'connected' })
    const offline = verdict({ relayHostReachability: 'host-offline' })
    expect(
      sessionStatusDot({
        verdict: offline,
        connState: 'reconnecting',
        presentedConnState: 'connected'
      })
    ).toEqual({ state: 'reconnecting', verdict: offline })
    expect(
      sessionStatusDot({
        verdict: offline,
        connState: 'reconnecting',
        presentedConnState: 'reconnecting'
      })
    ).toEqual({ state: 'reconnecting', verdict: offline })
  })
})
