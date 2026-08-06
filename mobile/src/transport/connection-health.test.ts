import { describe, expect, it } from 'vitest'
import {
  classifyConnection,
  isConnectionErrorVerdict,
  verdictDisplayLabel
} from './connection-health'

it('classifies only actionable connection failures as errors', () => {
  expect(isConnectionErrorVerdict({ kind: 'normal', label: 'Connected' })).toBe(false)
  expect(isConnectionErrorVerdict({ kind: 'warning', label: 'Cannot connect' })).toBe(true)
  expect(
    isConnectionErrorVerdict({ kind: 'unreachable', label: 'Unreachable', reason: 'stale' })
  ).toBe(true)
  expect(isConnectionErrorVerdict({ kind: 'auth-failed', label: 'Pairing invalid' })).toBe(true)
})

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
