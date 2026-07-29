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
