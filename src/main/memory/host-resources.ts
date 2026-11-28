import { runProcess } from '@orca/process-host'
import { readFile, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import {
  decodeHostResourcesSnapshot,
  type HostResourcesSnapshot
} from '../../shared/host-resources'
import { collectHostMemory } from './host-memory'
import { readHostCpu, type HostCpuReaders } from './host-cpu-sample'
import { readHostSwap, type HostSwapReaders } from './host-swap-usage'
import {
  readHostVolumes,
  type HostResourceVolumePath,
  type HostVolumeReaders
} from './host-volume-usage'

export type { CpuTimeSample } from './host-cpu-sample'
export type { HostResourceVolumePath, HostVolumeMeasurement } from './host-volume-usage'
export { cpuPercentsFromDelta } from './host-cpu-sample'
export { parseDarwinSwapUsage, parseLinuxSwap } from './host-swap-usage'
export { dedupeHostVolumes } from './host-volume-usage'

type HostResourcesReaders = HostCpuReaders &
  HostSwapReaders &
  HostVolumeReaders & {
    uptime: () => number
  }

export async function collectHostResources(
  volumePaths: readonly HostResourceVolumePath[],
  readers?: Partial<HostResourcesReaders>
): Promise<HostResourcesSnapshot> {
  const resolved = resolveReaders(readers)
  const [cpu, memory, volumes] = await Promise.all([
    readHostCpu(resolved),
    readMemory(resolved),
    readHostVolumes(volumePaths, resolved)
  ])
  const snapshot = {
    sampledAt: epochMilliseconds(resolved.now()),
    uptimeSeconds: nonNegative(resolved.uptime()),
    cpu,
    memory,
    volumes
  }
  const decoded = decodeHostResourcesSnapshot(snapshot)
  if (!decoded) {
    throw new Error('host_resources_snapshot_invalid')
  }
  return decoded
}

function resolveReaders(readers: Partial<HostResourcesReaders> | undefined): HostResourcesReaders {
  return {
    now: readers?.now ?? Date.now,
    readCpus: readers?.readCpus ?? (() => os.cpus()),
    wait:
      readers?.wait ??
      ((ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        })),
    platform: readers?.platform ?? (() => os.platform()),
    loadavg: readers?.loadavg ?? (() => os.loadavg()),
    uptime: readers?.uptime ?? (() => os.uptime()),
    readFile: readers?.readFile ?? ((file, encoding) => readFile(file, encoding)),
    runProcess: readers?.runProcess ?? runProcess,
    stat: readers?.stat ?? ((file) => stat(file)),
    statfs: readers?.statfs ?? ((file) => statfs(file))
  }
}

async function readMemory(readers: HostSwapReaders): Promise<HostResourcesSnapshot['memory']> {
  const [host, swap] = await Promise.all([collectHostMemory(), readHostSwap(readers)])
  return {
    usedBytes: byteCount(host.usedMemory),
    totalBytes: byteCount(host.totalMemory),
    usedPercent: clampPercent(host.memoryUsagePercent),
    swap
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}

function byteCount(value: number): number {
  const rounded = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  return Number.isSafeInteger(rounded) ? rounded : 0
}

function nonNegative(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function epochMilliseconds(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}
