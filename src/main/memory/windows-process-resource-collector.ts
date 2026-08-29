import os from 'node:os'
import { readWindowsProcessTableSnapshot } from '../windows/windows-process-table'
import type {
  ParsedWindowsProcessSample,
  WindowsProcessResourceRow
} from './windows-process-sample-parsing'

export type { WindowsProcessResourceRow } from './windows-process-sample-parsing'

const CPU_MIN_SAMPLE_MS = 250
const CPU_STALE_AFTER_MS = 10_000
const HUNDRED_NS_TICKS_PER_MS = 10_000

type WindowsProcessSample = ParsedWindowsProcessSample & {
  sampledAtMs: number
}

let previousCpuSample: WindowsProcessSample | null = null

export async function enumerateWindowsProcessResources(): Promise<WindowsProcessResourceRow[]> {
  const { rows, capturedAtMs } = await readWindowsProcessTableSnapshot()
  const cpuByPid = new Map<number, { cpuTicks: bigint; startTimeId: string }>()
  const resources = rows.map((row) => {
    const cpuTicks = parseUnsignedBigInt(row.cpuTimeTicks)
    if (cpuTicks !== null && row.startTimeId) {
      cpuByPid.set(row.pid, { cpuTicks, startTimeId: row.startTimeId })
    }
    return {
      pid: row.pid,
      ppid: row.ppid,
      cpu: 0,
      memory: nonNegativeNumber(row.memoryBytes),
      ...(row.privateMemoryBytes === undefined
        ? {}
        : { privateMemory: nonNegativeNumber(row.privateMemoryBytes) })
    }
  })
  return applyWindowsCpuSample({ rows: resources, cpuByPid, sampledAtMs: capturedAtMs })
}

function applyWindowsCpuSample(sample: WindowsProcessSample): WindowsProcessResourceRow[] {
  const previous = previousCpuSample
  if (!previous) {
    previousCpuSample = sample
    return sample.rows
  }
  const elapsedMs = sample.sampledAtMs - previous.sampledAtMs
  if (elapsedMs < CPU_MIN_SAMPLE_MS) {
    // Why: forced snapshots can land too close together for a stable rate.
    // Keep the older baseline so the next normal poll spans a useful interval.
    return sample.rows
  }
  previousCpuSample = sample
  if (elapsedMs > CPU_STALE_AFTER_MS) {
    // Why: closing Resource Manager or sleeping the machine leaves a stale
    // baseline whose long-term average is not the current CPU usage.
    return sample.rows
  }

  const maxProcessCpu = Math.max(1, os.cpus().length) * 100
  for (const row of sample.rows) {
    const currentTimes = sample.cpuByPid.get(row.pid)
    const previousTimes = previous.cpuByPid.get(row.pid)
    // Why: process start time prevents a recycled PID from inheriting the old
    // process's cumulative CPU time; counter resets likewise warm up again.
    if (
      !currentTimes ||
      !previousTimes ||
      currentTimes.startTimeId !== previousTimes.startTimeId ||
      currentTimes.cpuTicks < previousTimes.cpuTicks
    ) {
      continue
    }
    const cpuMs = Number(currentTimes.cpuTicks - previousTimes.cpuTicks) / HUNDRED_NS_TICKS_PER_MS
    row.cpu = Math.min(maxProcessCpu, nonNegativeNumber((cpuMs / elapsedMs) * 100))
  }
  return sample.rows
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function parseUnsignedBigInt(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  try {
    return BigInt(value)
  } catch {
    return null
  }
}
