import os from 'node:os'
import { performance } from 'node:perf_hooks'

const WINDOWS_CPU_MIN_SAMPLE_MS = 250
const WINDOWS_CPU_STALE_AFTER_MS = 10_000
const HUNDRED_NS_TICKS_PER_MS = 10_000

export type WindowsProcessRow = Readonly<{
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly command: string
  readonly executablePath: string
  /** Percent of one logical core; may exceed 100 for multithreaded processes. */
  readonly cpu: number
  /** Resident working-set bytes. */
  readonly memory: number
}>

export type WindowsRawProcessRow = Omit<WindowsProcessRow, 'cpu' | 'memory'> & {
  creationIdentity: string
  kernelModeTime100ns: bigint | null
  userModeTime100ns: bigint | null
  workingSetSize: number
}

type WindowsCpuBaseline = {
  creationIdentity: string
  cpu: number
  sampledAtMs: number
  totalCpuTime100ns: bigint
}

let windowsCpuBaselineByPid = new Map<number, WindowsCpuBaseline>()

export function windowsProcessString(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

export function windowsProcessNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  return typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
}

export function nonNegativeWindowsProcessNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function windowsProcessUint64(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return null
  }
  try {
    return BigInt(value.trim())
  } catch {
    return null
  }
}

export function sampleWindowsProcessUsage(
  rawRows: readonly WindowsRawProcessRow[]
): readonly WindowsProcessRow[] {
  const sampledAtMs = performance.now()
  const nextBaselines = new Map<number, WindowsCpuBaseline>()
  const maxProcessCpu = Math.max(1, os.cpus().length) * 100
  const rows = rawRows.map((raw): WindowsProcessRow => {
    const totalCpuTime100ns =
      raw.kernelModeTime100ns === null || raw.userModeTime100ns === null
        ? null
        : raw.kernelModeTime100ns + raw.userModeTime100ns
    const previous = windowsCpuBaselineByPid.get(raw.pid)
    let cpu = 0

    if (raw.creationIdentity && totalCpuTime100ns !== null) {
      const current: WindowsCpuBaseline = {
        creationIdentity: raw.creationIdentity,
        cpu: 0,
        sampledAtMs,
        totalCpuTime100ns
      }
      if (previous?.creationIdentity === raw.creationIdentity) {
        const elapsedMs = sampledAtMs - previous.sampledAtMs
        if (
          elapsedMs >= 0 &&
          elapsedMs < WINDOWS_CPU_MIN_SAMPLE_MS &&
          totalCpuTime100ns >= previous.totalCpuTime100ns
        ) {
          // Why: fresh foreground confirmations may force two scans too close
          // for Windows' process counters to produce a stable rate. Keep the
          // earlier baseline so the next normal-cadence scan spans enough time.
          cpu = previous.cpu
          nextBaselines.set(raw.pid, previous)
        } else if (
          elapsedMs >= WINDOWS_CPU_MIN_SAMPLE_MS &&
          elapsedMs <= WINDOWS_CPU_STALE_AFTER_MS &&
          totalCpuTime100ns >= previous.totalCpuTime100ns
        ) {
          const delta100ns = Number(totalCpuTime100ns - previous.totalCpuTime100ns)
          cpu = Math.min(
            maxProcessCpu,
            Math.max(0, (delta100ns / HUNDRED_NS_TICKS_PER_MS / elapsedMs) * 100)
          )
          nextBaselines.set(raw.pid, { ...current, cpu })
        } else {
          nextBaselines.set(raw.pid, current)
        }
      } else {
        // Creation identity protects the interval from PID reuse. Missing or
        // changed identities deliberately warm up again rather than guessing.
        nextBaselines.set(raw.pid, current)
      }
    }

    return {
      pid: raw.pid,
      ppid: raw.ppid,
      name: raw.name,
      command: raw.command,
      executablePath: raw.executablePath,
      cpu,
      memory: raw.workingSetSize
    }
  })
  windowsCpuBaselineByPid = nextBaselines
  return rows
}

export function resetWindowsProcessUsageForTests(): void {
  windowsCpuBaselineByPid = new Map()
}
