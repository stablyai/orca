import { describe, expect, it } from 'vitest'
import { buildHostResourceMetrics } from './host-metrics-handler'

describe('buildHostResourceMetrics', () => {
  it('computes used memory and usage percent', () => {
    const m = buildHostResourceMetrics({
      totalMemory: 16_000_000_000,
      freeMemory: 4_000_000_000,
      cpuCoreCount: 8,
      loadAverage: [1.5, 2.5, 3.5],
      uptimeSeconds: 3600,
      platform: 'linux'
    })
    expect(m.usedMemory).toBe(12_000_000_000)
    expect(m.memoryUsagePercent).toBeCloseTo(75)
    expect(m).toMatchObject({
      cpuCoreCount: 8,
      loadAverage1m: 1.5,
      loadAverage5m: 2.5,
      loadAverage15m: 3.5,
      uptimeSeconds: 3600,
      platform: 'linux'
    })
  })

  it('clamps NaN/negative os values to safe numbers', () => {
    const m = buildHostResourceMetrics({
      totalMemory: Number.NaN,
      freeMemory: -1,
      cpuCoreCount: 0,
      loadAverage: [Number.NaN, undefined as unknown as number, -2],
      uptimeSeconds: -5,
      platform: 'linux'
    })
    expect(m.totalMemory).toBe(0)
    expect(m.freeMemory).toBe(0)
    expect(m.usedMemory).toBe(0)
    expect(m.memoryUsagePercent).toBe(0)
    // cpuCoreCount floors at 1 so a renderer never divides by zero cores.
    expect(m.cpuCoreCount).toBe(1)
    expect(m.loadAverage1m).toBe(0)
    expect(m.loadAverage5m).toBe(0)
    expect(m.loadAverage15m).toBe(0)
    expect(m.uptimeSeconds).toBe(0)
  })

  it('never reports free memory above total (guards inconsistent reads)', () => {
    const m = buildHostResourceMetrics({
      totalMemory: 1000,
      freeMemory: 5000,
      cpuCoreCount: 2,
      loadAverage: [0, 0, 0],
      uptimeSeconds: 1,
      platform: 'darwin'
    })
    expect(m.freeMemory).toBe(1000)
    expect(m.usedMemory).toBe(0)
    expect(m.memoryUsagePercent).toBe(0)
  })

  it('reports zero load on Windows-style [0,0,0]', () => {
    const m = buildHostResourceMetrics({
      totalMemory: 8_000_000_000,
      freeMemory: 8_000_000_000,
      cpuCoreCount: 4,
      loadAverage: [0, 0, 0],
      uptimeSeconds: 100,
      platform: 'win32'
    })
    expect(m.loadAverage1m).toBe(0)
    expect(m.platform).toBe('win32')
  })
})
