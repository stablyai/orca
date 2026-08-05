import { describe, expect, it } from 'vitest'
import {
  classifyConnection,
  verdictDisplayLabel,
  verdictSupportingMessage
} from './connection-health'

describe('classifyConnection auth-failed verdict', () => {
  it('tells the user to re-pair instead of showing a generic auth error', () => {
    const verdict = classifyConnection({
      state: 'auth-failed',
      reconnectAttempts: 0,
      lastConnectedAt: null,
      nowMs: 1_000_000
    })
    expect(verdict.kind).toBe('auth-failed')
    expect(verdictDisplayLabel(verdict)).toBe('Pairing no longer works')
    expect(verdictSupportingMessage(verdict)).toContain('Try reconnecting once')
  })
})

describe('classifyConnection Tailscale hint', () => {
  const base = {
    state: 'reconnecting' as const,
    lastConnectedAt: null,
    nowMs: 1_000_000
  }

  it('adds the hint to the warning verdict for a tailnet CGNAT endpoint', () => {
    const verdict = classifyConnection({
      ...base,
      reconnectAttempts: 3,
      endpoint: 'ws://100.65.9.106:6768'
    })
    expect(verdict).toMatchObject({ kind: 'warning', hint: 'check Tailscale' })
  })

  it('adds the hint to the unreachable verdict for a MagicDNS endpoint', () => {
    const verdict = classifyConnection({
      ...base,
      reconnectAttempts: 12,
      endpoint: 'ws://my-desktop.tailnet-1234.ts.net:6768'
    })
    expect(verdict).toMatchObject({
      kind: 'unreachable',
      reason: 'never-connected',
      hint: 'check Tailscale'
    })
  })

  it('keeps plain labels for LAN endpoints', () => {
    const warning = classifyConnection({
      ...base,
      reconnectAttempts: 3,
      endpoint: 'ws://192.168.1.50:6768'
    })
    expect(warning.kind).toBe('warning')
    expect('hint' in warning && warning.hint).toBeFalsy()
  })

  it('keeps plain labels when no endpoint is provided', () => {
    const verdict = classifyConnection({ ...base, reconnectAttempts: 3 })
    expect(verdict.kind).toBe('warning')
    expect('hint' in verdict && verdict.hint).toBeFalsy()
  })

  it('never hints on healthy states', () => {
    const verdict = classifyConnection({
      state: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: 999_000,
      endpoint: 'ws://100.65.9.106:6768',
      nowMs: 1_000_000
    })
    expect(verdict).toEqual({ kind: 'normal', label: 'Connected' })
  })
})

// Issue #10119: every redial re-enters 'connecting', which used to revert an
// escalated verdict to "Connecting…" for the whole dial window — on a loop that
// had already failed for minutes, the user mostly saw the reassuring label.
describe('classifyConnection while dialing (issue #10119)', () => {
  const base = { lastConnectedAt: null, nowMs: 1_000_000 }

  it('keeps the warning verdict through a redial instead of reverting to Connecting…', () => {
    for (const state of ['connecting', 'handshaking'] as const) {
      const verdict = classifyConnection({ ...base, state, reconnectAttempts: 3 })
      expect(verdict).toMatchObject({
        kind: 'warning',
        label: 'Still trying to connect',
        reason: 'retrying'
      })
    }
  })

  it('keeps the unreachable verdict through a trickle dial', () => {
    const verdict = classifyConnection({ ...base, state: 'connecting', reconnectAttempts: 12 })
    expect(verdict).toMatchObject({ kind: 'unreachable', reason: 'never-connected' })
  })

  it('applies the stale heuristic while dialing too', () => {
    const verdict = classifyConnection({
      state: 'handshaking',
      reconnectAttempts: 12,
      lastConnectedAt: 900_000,
      nowMs: 1_000_000
    })
    expect(verdict).toMatchObject({ kind: 'unreachable', reason: 'stale' })
  })

  it('still shows Connecting… before any failures', () => {
    const verdict = classifyConnection({ ...base, state: 'connecting', reconnectAttempts: 0 })
    expect(verdict).toEqual({ kind: 'normal', label: 'Connecting…' })
  })

  it('still shows Connecting… below the warning gate', () => {
    const verdict = classifyConnection({ ...base, state: 'handshaking', reconnectAttempts: 2 })
    expect(verdict).toEqual({ kind: 'normal', label: 'Connecting…' })
  })
})

describe('verdictDisplayLabel', () => {
  it('appends the hint to warning and unreachable labels', () => {
    expect(
      verdictDisplayLabel({
        kind: 'warning',
        label: 'Still trying to connect',
        reason: 'retrying',
        hint: 'check Tailscale'
      })
    ).toBe('Still trying to connect — check Tailscale')
    expect(
      verdictDisplayLabel({
        kind: 'unreachable',
        label: 'Desktop unreachable',
        reason: 'stale',
        hint: 'check Tailscale'
      })
    ).toBe("Can't reach desktop through Tailscale")
  })

  it('returns the bare label without a hint', () => {
    expect(
      verdictDisplayLabel({
        kind: 'warning',
        label: 'Still trying to connect',
        reason: 'retrying'
      })
    ).toBe('Still trying to connect')
    expect(verdictDisplayLabel({ kind: 'normal', label: 'Connected' })).toBe('Connected')
  })
})

describe('verdictSupportingMessage', () => {
  it('explains automatic recovery for an unresponsive desktop', () => {
    const verdict = classifyConnection({
      state: 'connected',
      reconnectAttempts: 4,
      lastConnectedAt: 900_000,
      rpcUnresponsiveSince: 999_000,
      nowMs: 1_000_000
    })

    expect(verdictSupportingMessage(verdict)).toBe(
      "The connection is open, but desktop Orca isn't answering. Orca is checking the connection and will retry automatically."
    )
  })

  it('explains the slower background retry cadence', () => {
    const verdict = classifyConnection({
      state: 'reconnecting',
      reconnectAttempts: 12,
      lastConnectedAt: null,
      nowMs: 1_000_000
    })

    expect(verdictSupportingMessage(verdict)).toContain('retries have slowed to save battery')
  })

  it('gives specific Tailscale recovery steps', () => {
    const verdict = classifyConnection({
      state: 'reconnecting',
      reconnectAttempts: 12,
      lastConnectedAt: null,
      endpoint: 'ws://100.65.9.106:6768',
      nowMs: 1_000_000
    })

    expect(verdictSupportingMessage(verdict)).toContain('Open Tailscale')
    expect(verdictSupportingMessage(verdict)).toContain('Orca will keep retrying')
  })
})
