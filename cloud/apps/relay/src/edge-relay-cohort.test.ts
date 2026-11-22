import { describe, expect, it } from 'vitest'
import { edgeCohortBucketPermille, inEdgeCohort, mayBeOnEdge, type EdgeRelayConfig } from './edge-relay.js'
import { parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'

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

describe('the front door country ramp (frontDoorCountryRolloutPermille)', () => {
  const DOOR = 'https://cn.relay.example.test'
  const urls = { frontDoorUrls: new Set([DOOR]), regions: new Set(['us-central1', 'asia-east2'] as const) }
  const ramp = (frontDoorCountryRolloutPermille: number | undefined, regional = 1000): EdgeControlFlags => ({
    mode: 'on',
    leaveCeilingPermille: 1000,
    regionRolloutPermille: { 'us-central1': regional, 'asia-east2': regional },
    regionExcludeCountries: { 'us-central1': ['CN'], 'asia-east2': ['CN'] },
    frontDoor: { url: DOOR, countries: ['CN'] },
    ...(frontDoorCountryRolloutPermille === undefined ? {} : { frontDoorCountryRolloutPermille })
  })
  // Two hosts with a bucket boundary between them.
  const mid = hosts.find((host) => edgeCohortBucketPermille(host) >= 10 && edgeCohortBucketPermille(host) < 20)!

  it('admits an excluded country host only under the ramp', () => {
    // No ramp: the exclusion wins, as before.
    expect(inEdgeCohort(config(ramp(undefined), urls), low, 'asia-east2', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config(ramp(10), urls), low, 'asia-east2', undefined, 'CN')).toBe(true)
    expect(inEdgeCohort(config(ramp(10), urls), mid, 'asia-east2', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config(ramp(0), urls), low, 'asia-east2', undefined, 'CN')).toBe(false)
  })

  it('never past the region rollout, so the sweep (recorded region, no country) keeps every ramped host', () => {
    // Ramp above the region: the region caps it.
    expect(inEdgeCohort(config(ramp(1000, 10), urls), mid, 'asia-east2', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config(ramp(1000, 10), urls), low, 'asia-east2', undefined, 'CN')).toBe(true)
    // The sweep judges by the recorded region without a country: every ramped host is under it.
    for (const host of [low, mid]) {
      for (const [rampValue, regional] of [[10, 20], [20, 10], [20, 20]] as const) {
        if (inEdgeCohort(config(ramp(rampValue, regional), urls), host, 'asia-east2', undefined, 'CN')) {
          expect(inEdgeCohort(config(ramp(rampValue, regional), urls), host, 'asia-east2')).toBe(true)
        }
      }
    }
  })

  it('applies only to a listed country on a front door from the boot list', () => {
    // Not excluded: the ordinary rollout applies.
    expect(inEdgeCohort(config(ramp(0), urls), low, 'asia-east2', undefined, 'RU')).toBe(true)
    const otherExcluded: EdgeControlFlags = { ...ramp(1000), regionExcludeCountries: { 'asia-east2': ['CN', 'RU'] } }
    expect(inEdgeCohort(config(otherExcluded, urls), low, 'asia-east2', undefined, 'RU')).toBe(false)
    expect(inEdgeCohort(config(ramp(1000)), low, 'asia-east2', undefined, 'CN')).toBe(false)
    const noCountries: EdgeControlFlags = { ...ramp(1000), frontDoor: { url: DOOR } }
    expect(inEdgeCohort(config(noCountries, urls), low, 'asia-east2', undefined, 'CN')).toBe(false)
  })

  it('deny and mode still win', () => {
    expect(inEdgeCohort(config(ramp(1000), { ...urls, denyHosts: new Set([low]) }), low, 'asia-east2', undefined, 'CN')).toBe(false)
    expect(inEdgeCohort(config({ ...ramp(1000), mode: 'off' }, urls), low, 'asia-east2', undefined, 'CN')).toBe(false)
  })

  it('a bad value drops only the ramp and keeps the last applied one; frontDoor is untouched', () => {
    const body = (value: unknown) => ({
      v: 1,
      flags: { mode: 'on', frontDoor: { url: DOOR, countries: ['cn'] }, frontDoorCountryRolloutPermille: value }
    })
    expect(parseEdgeControl(body(50))?.flags).toMatchObject({ frontDoor: { url: DOOR, countries: ['CN'] }, frontDoorCountryRolloutPermille: 50 })
    for (const bad of [1001, 1.5, '50']) {
      const fresh = parseEdgeControl(body(bad))
      expect(fresh?.ignoredKeys).toEqual(['frontDoorCountryRolloutPermille'])
      expect(fresh?.flags.frontDoor).toEqual({ url: DOOR, countries: ['CN'] })
      expect(fresh?.flags.frontDoorCountryRolloutPermille).toBeUndefined()
      const kept = parseEdgeControlOver(body(bad), { mode: 'on', frontDoorCountryRolloutPermille: 30 })
      expect(kept?.flags.frontDoorCountryRolloutPermille).toBe(30)
    }
  })
})
