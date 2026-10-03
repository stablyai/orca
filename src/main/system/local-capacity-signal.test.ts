import { describe, expect, it, vi } from 'vitest'
import type { HostMemory } from '../../shared/process-stats-types'

vi.mock('electron', () => ({ powerMonitor: { isOnBatteryPower: vi.fn(() => false) } }))

import { readLocalCapacitySignal, type LocalCapacitySignalDeps } from './local-capacity-signal'

const GIB = 1024 ** 3

function healthyMemory(overrides: Partial<HostMemory> = {}): HostMemory {
  return {
    totalMemory: 32 * GIB,
    freeMemory: 16 * GIB,
    availableMemory: 16 * GIB,
    availableMemorySource: 'free-memory',
    usedMemory: 16 * GIB,
    memoryUsagePercent: 50,
    cpuCoreCount: 8,
    loadAverage1m: 0,
    ...overrides
  }
}

function readSignal(overrides: Partial<LocalCapacitySignalDeps> = {}) {
  return readLocalCapacitySignal({
    isOnBatteryPower: () => false,
    collectHostMemory: async () => healthyMemory(),
    cpuCount: () => 8,
    ...overrides
  })
}

describe('readLocalCapacitySignal', () => {
  it('reports no flags on a healthy host', async () => {
    await expect(readSignal()).resolves.toEqual({
      onBattery: false,
      lowMemory: false,
      lowCpu: false,
      reasons: []
    })
  })

  it('flags battery power', async () => {
    const signal = await readSignal({ isOnBatteryPower: () => true })

    expect(signal.onBattery).toBe(true)
    expect(signal.reasons).toEqual(['on battery'])
  })

  it('treats a throwing power API as not-on-battery', async () => {
    const signal = await readSignal({
      isOnBatteryPower: () => {
        throw new Error('unsupported')
      }
    })

    expect(signal.onBattery).toBe(false)
    expect(signal.reasons).toEqual([])
  })

  it('flags a host under 8 GiB of total memory', async () => {
    const signal = await readSignal({
      collectHostMemory: async () =>
        healthyMemory({ totalMemory: 4 * GIB, availableMemory: 4 * GIB })
    })

    expect(signal.lowMemory).toBe(true)
    expect(signal.reasons).toEqual(['low memory'])
  })

  it('flags a host with under 15% of memory available', async () => {
    // 4 GiB free of 32 GiB is 12.5%.
    const signal = await readSignal({
      collectHostMemory: async () => healthyMemory({ availableMemory: 4 * GIB })
    })

    expect(signal.lowMemory).toBe(true)
  })

  it('does not flag memory at exactly 15% available', async () => {
    // 6 GiB of 40 GiB is exactly 15%, which pins the strict `<` comparison.
    const signal = await readSignal({
      collectHostMemory: async () =>
        healthyMemory({ totalMemory: 40 * GIB, availableMemory: 6 * GIB })
    })

    expect(signal.lowMemory).toBe(false)
  })

  it('flags fewer than four CPU cores', async () => {
    const signal = await readSignal({ cpuCount: () => 2 })

    expect(signal.lowCpu).toBe(true)
    expect(signal.reasons).toEqual(['few CPU cores'])
  })

  it('does not flag exactly four CPU cores', async () => {
    const signal = await readSignal({ cpuCount: () => 4 })

    expect(signal.lowCpu).toBe(false)
  })

  it('lists one reason per true flag', async () => {
    const signal = await readSignal({
      isOnBatteryPower: () => true,
      collectHostMemory: async () =>
        healthyMemory({ totalMemory: 4 * GIB, availableMemory: 4 * GIB }),
      cpuCount: () => 1
    })

    expect(signal).toEqual({
      onBattery: true,
      lowMemory: true,
      lowCpu: true,
      reasons: ['on battery', 'low memory', 'few CPU cores']
    })
  })
})
