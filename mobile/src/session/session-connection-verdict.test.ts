import { describe, expect, it } from 'vitest'
import { translate } from '../i18n/mobile-i18n'
import { verdictDisplayLabel } from '../transport/connection/connection-health'
import {
  sessionConnectionVerdict,
  type SessionConnectionVerdictInputs
} from './session-connection-verdict'

const NOW = 1_000_000_000
const TAILSCALE_ENDPOINT = 'ws://100.101.102.103:6768'

function tailscaleSession(
  overrides: Partial<SessionConnectionVerdictInputs> = {}
): SessionConnectionVerdictInputs {
  return {
    state: 'reconnecting',
    reconnectAttempts: 5,
    lastConnectedAt: NOW - 5 * 60_000,
    endpoint: TAILSCALE_ENDPOINT,
    hostName: 'Work laptop',
    pendingPath: null,
    pairingRejected: false,
    relayHostReachability: 'connecting',
    nowMs: NOW,
    ...overrides
  }
}

function label(overrides: Partial<SessionConnectionVerdictInputs> = {}): string {
  return verdictDisplayLabel(
    sessionConnectionVerdict(tailscaleSession(overrides), translate),
    translate
  )
}

describe('sessionConnectionVerdict', () => {
  it('keeps the Tailscale hint when there is no relay evidence', () => {
    expect(label()).toBe("Can't connect — check Tailscale")
  })

  it('names the offline host instead of blaming Tailscale', () => {
    const verdict = sessionConnectionVerdict(
      tailscaleSession({ relayHostReachability: 'host-offline' }),
      translate
    )
    expect(verdict.kind).toBe('unreachable')
    expect(verdictDisplayLabel(verdict, translate)).toBe('Work laptop is offline')
  })

  it('says Relay refused access when the relay refused the credential', () => {
    expect(label({ relayHostReachability: 'credential-refused' })).toBe(
      'Relay refused access for Work laptop'
    )
  })

  it("says it can't reach Relay when the cell was unreachable", () => {
    const verdict = sessionConnectionVerdict(
      tailscaleSession({ relayHostReachability: 'unreachable' }),
      translate
    )
    expect(verdict.kind).toBe('warning')
    expect(verdictDisplayLabel(verdict, translate)).toBe("Can't reach Relay")
  })

  it('says Connecting via Relay while Relay is being dialed', () => {
    const verdict = sessionConnectionVerdict(tailscaleSession({ pendingPath: 'relay' }), translate)
    expect(verdict).toMatchObject({ kind: 'normal', dialing: true })
    expect(verdictDisplayLabel(verdict, translate)).toBe('Connecting via Relay…')
  })

  it('never mentions Tailscale for any relay verdict', () => {
    for (const relayHostReachability of [
      'host-offline',
      'credential-refused',
      'unreachable',
      'signed-out'
    ] as const) {
      expect(label({ relayHostReachability, reconnectAttempts: 20 })).not.toContain('Tailscale')
    }
  })

  it('falls back to a generic host name before the stored name loads', () => {
    expect(label({ hostName: null, relayHostReachability: 'host-offline' })).toBe('Host is offline')
  })
})
