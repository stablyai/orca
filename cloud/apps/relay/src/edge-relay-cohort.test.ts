import { describe, expect, it } from 'vitest'
import { edgeCohortBucketPermille, mayBeOnEdge, type EdgeRelayConfig } from './edge-relay-cohort.js'
import { parseEdgeControl, type EdgeControlFlags } from './edge-relay-control.js'

function config(flags: EdgeControlFlags, overrides: Partial<EdgeRelayConfig> = {}): EdgeRelayConfig {
  return {
    cellUrl: 'https://edge.relay.example.test',
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    control: () => flags,
    ...overrides
  }
}

// Hosts with known buckets: one under 10 permille, one at or above 20.
const hosts = Array.from({ length: 400 }, (_, index) => `ceilinghost${String(index).padStart(5, '0')}`)
const low = hosts.find((host) => edgeCohortBucketPermille(host) < 10)!
const high = hosts.find((host) => edgeCohortBucketPermille(host) >= 20)!

describe('mayBeOnEdge', () => {
  it('is true for every host without a ceiling (today)', () => {
    expect(mayBeOnEdge(config({ mode: 'on', rolloutPermille: 0 }), high)).toBe(true)
  })

  it('is false only above the ceiling, the current rollout and the env percent', () => {
    expect(mayBeOnEdge(config({ mode: 'on', rolloutPermille: 10, leaveCeilingPermille: 10 }), low)).toBe(true)
    expect(mayBeOnEdge(config({ mode: 'on', rolloutPermille: 10, leaveCeilingPermille: 10 }), high)).toBe(false)
    // A rollout above a stale ceiling still counts.
    expect(mayBeOnEdge(config({ mode: 'on', rolloutPermille: 1000, leaveCeilingPermille: 10 }), high)).toBe(true)
    expect(mayBeOnEdge(config({ mode: 'on', leaveCeilingPermille: 0 }, { rolloutPercent: 100 }), high)).toBe(true)
  })

  it('keeps allow and deny listed hosts and accounts, and ignores the mode', () => {
    const flags: EdgeControlFlags = { mode: 'off', leaveCeilingPermille: 0 }
    expect(mayBeOnEdge(config(flags), low)).toBe(false)
    expect(mayBeOnEdge(config(flags, { allowHosts: new Set([high]) }), high)).toBe(true)
    expect(mayBeOnEdge(config(flags, { denyHosts: new Set([high]) }), high)).toBe(true)
    expect(mayBeOnEdge(config(flags, { allowUsers: new Set(['user-1']) }), high, 'user-1')).toBe(true)
    expect(mayBeOnEdge(config({ mode: 'down', leaveCeilingPermille: 10 }), low)).toBe(true)
  })
})

describe('edge control leaveCeilingPermille', () => {
  it('parses, and a bad value voids the object', () => {
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on', rolloutPermille: 10, leaveCeilingPermille: 10 } })).toEqual({
      flags: { mode: 'on', rolloutPermille: 10, leaveCeilingPermille: 10 },
      ignoredKeys: []
    })
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on' } })).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on', leaveCeilingPermille: 1001 } })).toBeNull()
    // A ceiling below the rollout is a mistake: the last applied flags stay.
    expect(parseEdgeControl({ v: 1, flags: { mode: 'on', rolloutPermille: 20, leaveCeilingPermille: 10 } })).toBeNull()
  })
})
