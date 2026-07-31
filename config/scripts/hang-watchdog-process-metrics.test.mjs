import { describe, expect, it } from 'vitest'
import {
  parsePhysicalFootprintBytes,
  parseProcessCpuTimeMs
} from './hang-watchdog-process-metrics.mjs'

describe('hang watchdog process metrics', () => {
  it('uses the de-duplicated summary for multiple processes', () => {
    const output = `
Electron [101]: 64-bit    Footprint: 5000000 B (16384 bytes per page)
    phys_footprint: 5100000 B
Electron Helper [102]: 64-bit    Footprint: 2000000 B (16384 bytes per page)
    phys_footprint: 2100000 B
Summary Footprint: 6259264 B
`
    expect(parsePhysicalFootprintBytes(output, 2)).toBe(6_259_264)
  })

  it('uses the process footprint rather than auxiliary accounting for one process', () => {
    const output = `
Electron [101]: 64-bit    Footprint: 5000000 B (16384 bytes per page)
    phys_footprint: 5100000 B
`
    expect(parsePhysicalFootprintBytes(output, 1)).toBe(5_000_000)
  })

  it('rejects missing or zero footprint summaries', () => {
    expect(parsePhysicalFootprintBytes('phys_footprint: 100 B', 2)).toBeNull()
    expect(parsePhysicalFootprintBytes('Summary Footprint: 0 B', 2)).toBeNull()
  })

  it.each([
    ['0:00.04', 40],
    ['1:02.50', 62_500],
    ['2:01:02.50', 7_262_500]
  ])('parses ps CPU time %s', (value, expected) => {
    expect(parseProcessCpuTimeMs(value)).toBe(expected)
  })

  it('rejects invalid CPU times', () => {
    expect(parseProcessCpuTimeMs('')).toBeNull()
    expect(parseProcessCpuTimeMs('not-a-time')).toBeNull()
    expect(parseProcessCpuTimeMs('-1:00')).toBeNull()
  })
})
