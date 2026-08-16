import { describe, expect, it } from 'vitest'
import { deriveBrowserRoutePartition } from './browser-route-identity'

const identity = {
  orcaProfileId: 'orca/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired/runtime:authority',
  executionHostIdentity: 'ssh/target:private.example'
}

describe('browser route partition identity', () => {
  it('derives a stable opaque cross-platform partition and binding fingerprint', () => {
    const first = deriveBrowserRoutePartition(identity)
    const second = deriveBrowserRoutePartition({ ...identity })

    expect(second).toEqual(first)
    expect(first.partition).toMatch(/^persist:orca-browser-v1-[a-f0-9]{64}$/)
    expect(first.bindingFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(first.partition.slice('persist:'.length)).toMatch(/^[a-z0-9-]+$/)
    for (const rawIdentity of Object.values(identity)) {
      expect(first.partition).not.toContain(rawIdentity)
    }
    expect(first.partition).not.toContain('private.example')
  })

  it('keeps delimiter-containing components structurally distinct', () => {
    const left = deriveBrowserRoutePartition({
      ...identity,
      orcaProfileId: 'a',
      browserProfileId: 'b:c'
    })
    const right = deriveBrowserRoutePartition({
      ...identity,
      orcaProfileId: 'a:b',
      browserProfileId: 'c'
    })

    expect(left).not.toEqual(right)
  })

  it('does not expose equality of individual identity components', () => {
    const baseline = deriveBrowserRoutePartition(identity).partition
    const sameProfile = deriveBrowserRoutePartition({
      ...identity,
      executionHostIdentity: 'ssh/target:other.example'
    }).partition

    expect(baseline.split('-').at(-1)).not.toBe(sameProfile.split('-').at(-1))
    expect(baseline).not.toMatch(/:[a-f0-9]{16}:/)
  })

  it('rejects empty and unbounded identity components', () => {
    expect(() => deriveBrowserRoutePartition({ ...identity, executionHostIdentity: '' })).toThrow(
      'browser_route_partition_identity_invalid'
    )
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'x'.repeat(513) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(257) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(256) })
    ).not.toThrow()
  })
})
