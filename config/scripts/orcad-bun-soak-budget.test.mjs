import { describe, expect, it } from 'vitest'
import { evaluateOrcadBunSoakBudget, parseOrcadBunSoakOptions } from './orcad-bun-soak-budget.mjs'

describe('orcad Bun soak options', () => {
  it('accepts direct, equals, environment, and pnpm-separator cycle forms', () => {
    expect(parseOrcadBunSoakOptions(['--cycles', '7'], {})).toMatchObject({ cycles: 7 })
    expect(parseOrcadBunSoakOptions(['--cycles=8'], {})).toMatchObject({ cycles: 8 })
    expect(parseOrcadBunSoakOptions([], { ORCA_ORCAD_BUN_SOAK_CYCLES: '9' })).toMatchObject({
      cycles: 9
    })
    expect(parseOrcadBunSoakOptions(['--', '--cycles', '10'], {})).toMatchObject({ cycles: 10 })
  })

  it('rejects missing, invalid, excessive, and unknown arguments', () => {
    expect(() => parseOrcadBunSoakOptions(['--cycles'], {})).toThrow('requires a value')
    expect(() => parseOrcadBunSoakOptions(['--cycles', '1.5'], {})).toThrow('positive integer')
    expect(() => parseOrcadBunSoakOptions(['--cycles', '10001'], {})).toThrow('between 1 and 10000')
    expect(() => parseOrcadBunSoakOptions(['--duration', '10'], {})).toThrow('Unknown')
  })
})

describe('orcad Bun soak resource budget', () => {
  const sample = (cycle, rssBytes, heapUsedBytes, openDescriptors) => ({
    cycle,
    rssBytes,
    heapUsedBytes,
    openDescriptors
  })

  it('reports bounded RSS, heap, and descriptor growth', () => {
    const result = evaluateOrcadBunSoakBudget([sample(1, 100, 50, 5), sample(2, 120, 60, 6)], 25)

    expect(result.failures).toEqual([])
    expect(result).toMatchObject({
      rssGrowthBytes: 20,
      heapGrowthBytes: 10,
      descriptorGrowth: 1
    })
  })

  it('fails independently on retained RSS, heap, and descriptors', () => {
    const result = evaluateOrcadBunSoakBudget(
      [sample(1, 100, 50, 5), sample(2, 200, 40 * 1024 * 1024, 10)],
      50
    )

    expect(result.failures).toHaveLength(3)
  })

  it('supports platforms without descriptor enumeration', () => {
    const result = evaluateOrcadBunSoakBudget(
      [sample(1, 100, 50, null), sample(2, 110, 60, null)],
      20
    )

    expect(result.failures).toEqual([])
    expect(result.descriptorGrowth).toBeNull()
  })
})
