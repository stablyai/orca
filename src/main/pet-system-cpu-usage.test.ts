import { describe, expect, it } from 'vitest'
import type { cpus } from 'node:os'
import { createPetSystemCpuUsageSampler } from './pet-system-cpu-usage'

type CpuInfo = ReturnType<typeof cpus>[number]

function cpu(times: CpuInfo['times']): CpuInfo {
  return {
    model: 'test',
    speed: 1,
    times
  }
}

describe('createPetSystemCpuUsageSampler', () => {
  it('returns null for the first sample', () => {
    const sampler = createPetSystemCpuUsageSampler(() => [
      cpu({ user: 10, nice: 0, sys: 10, idle: 80, irq: 0 })
    ])

    expect(sampler()).toBeNull()
  })

  it('returns host-wide busy time from aggregate CPU tick deltas', () => {
    const samples = [
      [
        cpu({ user: 30, nice: 0, sys: 20, idle: 50, irq: 0 }),
        cpu({ user: 60, nice: 0, sys: 40, idle: 100, irq: 0 })
      ],
      [
        cpu({ user: 100, nice: 0, sys: 25, idle: 75, irq: 0 }),
        cpu({ user: 130, nice: 0, sys: 45, idle: 125, irq: 0 })
      ]
    ]
    const sampler = createPetSystemCpuUsageSampler(() => samples.shift() ?? [])

    expect(sampler()).toBeNull()
    expect(sampler()).toBe(0.75)
  })

  it('returns null when counters reset', () => {
    const samples = [
      [cpu({ user: 30, nice: 0, sys: 20, idle: 50, irq: 0 })],
      [cpu({ user: 20, nice: 0, sys: 20, idle: 40, irq: 0 })]
    ]
    const sampler = createPetSystemCpuUsageSampler(() => samples.shift() ?? [])

    expect(sampler()).toBeNull()
    expect(sampler()).toBeNull()
  })

  it('returns null when no ticks elapsed', () => {
    const sample = [cpu({ user: 30, nice: 0, sys: 20, idle: 50, irq: 0 })]
    const sampler = createPetSystemCpuUsageSampler(() => sample)

    expect(sampler()).toBeNull()
    expect(sampler()).toBeNull()
  })

  it('clamps invalid idle deltas to the usage range', () => {
    const samples = [
      [cpu({ user: 100, nice: 0, sys: 0, idle: 0, irq: 0 })],
      [cpu({ user: 50, nice: 0, sys: 0, idle: 100, irq: 0 })]
    ]
    const sampler = createPetSystemCpuUsageSampler(() => samples.shift() ?? [])

    expect(sampler()).toBeNull()
    expect(sampler()).toBe(0)
  })
})
