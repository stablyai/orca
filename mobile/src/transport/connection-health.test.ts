import { describe, expect, it } from 'vitest'
import { classifyConnection, verdictDisplayLabel } from './connection-health'

describe('classifyConnection auth-failed verdict', () => {
  it('tells the user to re-pair instead of showing a generic auth error', () => {
    const verdict = classifyConnection({
      state: 'auth-failed',
      reconnectAttempts: 0,
      lastConnectedAt: null,
      nowMs: 1_000_000
    })
    expect(verdict.kind).toBe('auth-failed')
    expect(verdictDisplayLabel(verdict)).toBe('Pairing invalid — re-pair with your desktop')
  })
})

describe('classifyConnection pairing-rejected verdict', () => {
  it('outranks a pending Relay recovery that would otherwise read as progress', () => {
    const verdict = classifyConnection({
      state: 'disconnected',
      reconnectAttempts: 1,
      lastConnectedAt: 1_000,
      pendingPath: 'relay',
      pairingRejected: true,
      nowMs: 1_000_000
    })
    expect(verdict.kind).toBe('auth-failed')
    expect(verdictDisplayLabel(verdict)).toBe('Pairing invalid — re-pair with your desktop')
  })

  it('never overrides a live connection', () => {
    const verdict = classifyConnection({
      state: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: 999_000,
      pairingRejected: true,
      nowMs: 1_000_000
    })
    expect(verdict).toEqual({ kind: 'normal', label: 'Connected' })
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
      endpoint: 'ws://100.65.9.106:6768',
      pendingPath: null
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

  it('presents an in-flight relay fallback instead of the failed Tailscale path', () => {
    const incident = {
      ...base,
      reconnectAttempts: 5,
      endpoint: 'ws://100.88.90.25:6768',
      pendingPath: 'relay' as const
    }

    for (const state of ['connecting', 'handshaking', 'reconnecting', 'disconnected'] as const) {
      const verdict = classifyConnection({ ...incident, state })
      expect(verdict).toEqual({ kind: 'normal', label: 'Connecting via Relay…' })
      expect(verdictDisplayLabel(verdict)).not.toContain('Tailscale')
    }
  })

  it('escalates a prolonged relay recovery without reviving the Tailscale hint', () => {
    const verdict = classifyConnection({
      ...base,
      reconnectAttempts: 12,
      endpoint: 'ws://100.88.90.25:6768',
      pendingPath: 'relay'
    })

    expect(verdict).toEqual({
      kind: 'unreachable',
      label: "Can't connect via Relay",
      reason: 'never-connected'
    })
    expect(verdictDisplayLabel(verdict)).not.toContain('Tailscale')
  })

  it('does not call an idle Relay path Connecting when no retry is active', () => {
    const verdict = classifyConnection({
      state: 'disconnected',
      reconnectAttempts: 0,
      lastConnectedAt: 1_000,
      pendingPath: 'relay',
      nowMs: 1_000_000
    })

    expect(verdict).toEqual({ kind: 'normal', label: 'Disconnected' })
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
      expect(verdict).toMatchObject({ kind: 'warning', label: "Can't connect" })
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
      verdictDisplayLabel({ kind: 'warning', label: "Can't connect", hint: 'check Tailscale' })
    ).toBe("Can't connect — check Tailscale")
    expect(
      verdictDisplayLabel({
        kind: 'unreachable',
        label: "Can't reach desktop",
        reason: 'stale',
        hint: 'check Tailscale'
      })
    ).toBe("Can't reach desktop — check Tailscale")
  })

  it('returns the bare label without a hint', () => {
    expect(verdictDisplayLabel({ kind: 'warning', label: "Can't connect" })).toBe("Can't connect")
    expect(verdictDisplayLabel({ kind: 'normal', label: 'Connected' })).toBe('Connected')
  })
})
