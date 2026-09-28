import { describe, expect, it } from 'vitest'
import { buildUnits, packShards, planShards } from './run-anti-slop-shards.mjs'

// Why these properties: the sharded pass equals a single pass only if every file is linted by
// exactly one shard. Coverage and disjointness are what carry that, so they are asserted
// directly rather than by diffing two multi-minute lint runs.
function filesUnder(unit, files) {
  return files.filter((file) => file === unit || file.startsWith(`${unit}/`))
}

function coveredBy(units, files) {
  return files.filter((file) => units.some((unit) => file === unit || file.startsWith(`${unit}/`)))
}

const SAMPLE = [
  'src/renderer/src/components/a.tsx',
  'src/renderer/src/components/b.tsx',
  'src/renderer/src/hooks/c.ts',
  'src/renderer/index.ts',
  'src/main/agent/d.ts',
  'src/main/agent/e.ts',
  'src/main/f.ts',
  'src/shared/g.ts',
  'config/scripts/h.mjs',
  'tests/e2e/i.spec.ts',
  'mobile/src/j.tsx',
  'mobile/src/k.tsx'
]

describe('anti-slop shard planning', () => {
  it('covers every file exactly once across units', () => {
    const units = buildUnits(SAMPLE, 3).map((entry) => entry.unit)
    for (const file of SAMPLE) {
      const owners = units.filter((unit) => file === unit || file.startsWith(`${unit}/`))
      expect(owners, `${file} owned by ${JSON.stringify(owners)}`).toHaveLength(1)
    }
  })

  it('reports a unit count that matches the files it owns', () => {
    for (const { unit, count } of buildUnits(SAMPLE, 3)) {
      expect(count).toBe(filesUnder(unit, SAMPLE).length)
    }
  })

  it('splits a directory larger than the target instead of leaving it whole', () => {
    // src/renderer holds 4 of 12 sample files through a single child directory, so the
    // splitter has to descend more than one level to get under a small target.
    const units = buildUnits(SAMPLE, 2).map((entry) => entry.unit)
    expect(units).not.toContain('src')
    expect(units.some((unit) => unit.startsWith('src/renderer/'))).toBe(true)
  })

  it('assigns every unit to exactly one shard and keeps shards disjoint', () => {
    const { units, bins } = planShards(SAMPLE, 3)
    const assigned = bins.flatMap((bin) => bin.units)
    expect(assigned.slice().sort()).toEqual(units.map((entry) => entry.unit).sort())
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(coveredBy(assigned, SAMPLE)).toHaveLength(SAMPLE.length)
  })

  it('keeps the heaviest shard near the mean so wall time is not bound by one shard', () => {
    const files = Array.from({ length: 400 }, (_, index) => `src/pkg${index % 40}/file${index}.ts`)
    const { bins } = planShards(files, 4)
    const heaviest = Math.max(...bins.map((bin) => bin.count))
    expect(heaviest).toBeLessThanOrEqual(Math.ceil(files.length / 4) * 1.35)
  })

  it('never emits more shards than there are units', () => {
    expect(packShards(buildUnits(['src/a.ts'], 1), 4)).toHaveLength(1)
  })
})
