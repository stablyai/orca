import { describe, expect, it } from 'vitest'
import { edgeCohortBucketPermille, inEdgeCohort, mayBeOnEdge, type EdgeRelayConfig } from './edge-relay.js'
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

describe('a host listed by id on a front door (frontDoor.hosts)', () => {
  const DOOR = 'https://cn.relay.example.test'
  const excluded: EdgeControlFlags = {
    mode: 'on',
    rolloutPermille: 1000,
    leaveCeilingPermille: 1000,
    regionExcludeCountries: { 'us-central1': ['CN'], 'asia-east2': ['CN'] }
  }
  const listed: EdgeControlFlags = { ...excluded, frontDoor: { url: DOOR, hosts: [high] } }
  const urls = { frontDoorUrls: new Set([DOOR]) }

  it('is in the cohort despite its country exclusion, also for the sweep', () => {
    expect(inEdgeCohort(config(excluded, urls), high, 'us-central1', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config(listed, urls), high, 'us-central1', undefined, 'CN')).toBe(true)
    expect(inEdgeCohort(config(listed, urls), high, 'asia-east2', undefined, 'CN')).toBe(true)
    expect(inEdgeCohort(config(listed, urls), high, 'any')).toBe(true)
    // Only that host, and only for a front door on the boot list.
    expect(inEdgeCohort(config(listed, urls), low, 'us-central1', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config(listed), high, 'us-central1', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config({ ...listed, frontDoor: { url: 'https://other.example.test', hosts: [high] } }, urls), high, 'us-central1', undefined, 'CN')).toBe(false)
  })

  it('deny and mode still win', () => {
    expect(inEdgeCohort(config(listed, { ...urls, denyHosts: new Set([high]) }), high, 'us-central1', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config({ ...listed, mode: 'off' }, urls), high, 'us-central1', undefined, 'CN')).toBe(false)
  })

  it('may be on the edge above the ceiling while listed', () => {
    const tight: EdgeControlFlags = { mode: 'on', rolloutPermille: 10, leaveCeilingPermille: 10, frontDoor: { url: DOOR, hosts: [high] } }
    expect(mayBeOnEdge(config(tight, urls), high)).toBe(true)
    expect(mayBeOnEdge(config({ ...tight, frontDoor: undefined }, urls), high)).toBe(false)
  })
})
