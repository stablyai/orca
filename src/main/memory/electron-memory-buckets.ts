import { getAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import type { AppMemory, UsageValues } from '../../shared/process-stats-types'
import { clampMemoryMetric, optionalCommitField } from './memory-snapshot-values'

type ElectronProcessIndex = {
  byPid: Map<number, { memory: number; privateMemory?: number }>
  hasAnyPrivateMemory: boolean
}

export type AppBucketsRaw = Omit<AppMemory, 'history'>

function electronMetricMemoryBytes(
  proc: ReturnType<AppEnvironment['getAppMetrics']>[number],
  processIndex: ElectronProcessIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  return clampMemoryMetric(proc.memory?.workingSetSize) * 1024
}

export function bucketElectronMetrics(processIndex: ElectronProcessIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0, privateMemory: 0, privateMemoryComplete: true, count: 0 }
  const renderer = { ...main }
  const other = { ...main }

  for (const proc of getAppEnvironment().getAppMetrics()) {
    const type = (typeof proc.type === 'string' ? proc.type : '').toLowerCase()
    const target =
      type === 'browser' ? main : type === 'renderer' || type === 'tab' ? renderer : other
    const privateBytes = processIndex.byPid.get(proc.pid)?.privateMemory
    target.count += 1
    target.cpu += clampMemoryMetric(proc.cpu?.percentCPUUsage)
    target.memory += electronMetricMemoryBytes(proc, processIndex)
    target.privateMemoryComplete &&= privateBytes !== undefined
    target.privateMemory += clampMemoryMetric(privateBytes)
  }

  const usage = (bucket: typeof main): UsageValues => ({
    cpu: bucket.cpu,
    memory: bucket.memory,
    ...optionalCommitField(
      bucket.privateMemoryComplete && (bucket.count > 0 || processIndex.hasAnyPrivateMemory),
      bucket.privateMemory
    )
  })
  const total = {
    cpu: main.cpu + renderer.cpu + other.cpu,
    memory: main.memory + renderer.memory + other.memory,
    privateMemory: main.privateMemory + renderer.privateMemory + other.privateMemory,
    privateMemoryComplete:
      main.privateMemoryComplete && renderer.privateMemoryComplete && other.privateMemoryComplete,
    count: main.count + renderer.count + other.count
  }
  return { main: usage(main), renderer: usage(renderer), other: usage(other), ...usage(total) }
}
