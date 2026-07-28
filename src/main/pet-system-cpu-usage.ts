import { cpus } from 'node:os'

type CpuSnapshot = {
  idle: number
  total: number
}

type ReadCpuInfo = typeof cpus

function readSnapshot(readCpuInfo: ReadCpuInfo): CpuSnapshot {
  let idle = 0
  let total = 0

  for (const cpu of readCpuInfo()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }

  return { idle, total }
}

export function createPetSystemCpuUsageSampler(
  readCpuInfo: ReadCpuInfo = cpus
): () => number | null {
  let previous: CpuSnapshot | null = null

  return () => {
    const current = readSnapshot(readCpuInfo)
    const prior = previous
    previous = current

    if (!prior || current.idle < prior.idle || current.total < prior.total) {
      return null
    }

    const idleDelta = current.idle - prior.idle
    const totalDelta = current.total - prior.total
    if (totalDelta === 0) {
      return null
    }

    return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
  }
}

export const samplePetSystemCpuUsage = createPetSystemCpuUsageSampler()
