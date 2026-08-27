import { runProcess } from '../../shared/child-process/run-process'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  parseTypeperfProcessOutput,
  parseWindowsProcessSample,
  TYPEPERF_COUNTERS,
  type ParsedWindowsProcessSample,
  type WindowsProcessResourceRow
} from './windows-process-sample-parsing'

export type { WindowsProcessResourceRow } from './windows-process-sample-parsing'

const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_QUERY_MAX_BUFFER = 10 * 1024 * 1024
const CPU_MIN_SAMPLE_MS = 250
const CPU_STALE_AFTER_MS = 10_000
const HUNDRED_NS_TICKS_PER_MS = 10_000
const CIM_RETRY_AFTER_MS = 30_000

type WindowsProcessSample = ParsedWindowsProcessSample & {
  sampledAtMs: number
}

let processBackend: 'cim' | 'typeperf' = 'cim'
let previousCpuSample: WindowsProcessSample | null = null
let retryCimAtMs = 0

export async function enumerateWindowsProcessResources(): Promise<WindowsProcessResourceRow[]> {
  // Why: one CIM sweep supplies both resource values and process identity,
  // avoiding a second host-wide PowerShell process on every open-popover poll.
  if (processBackend === 'typeperf') {
    if (performance.now() < retryCimAtMs) {
      return enumerateWindowsWithTypeperf()
    }
    processBackend = 'cim'
  }

  const sample = await enumerateWindowsWithCim()
  if (sample) {
    return applyWindowsCpuSample(sample)
  }
  // Why: avoid repeating a blocked CIM timeout every two-second poll while
  // still recovering CPU attribution after a transient PowerShell failure.
  processBackend = 'typeperf'
  retryCimAtMs = performance.now() + CIM_RETRY_AFTER_MS
  previousCpuSample = null
  return enumerateWindowsWithTypeperf()
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

async function enumerateWindowsWithCim(): Promise<WindowsProcessSample | null> {
  // PageFileUsage rides along on the sweep that already runs: it is the commit
  // charge the working set stops showing once Windows starts trimming pages.
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate,PageFileUsage | ' +
      'ForEach-Object { try { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, [string]$_.KernelModeTime, [string]$_.UserModeTime, $_.CreationDate.ToUniversalTime().Ticks, $_.PageFileUsage)) } catch {} }'
  ]
  try {
    const stdout = await execFileText('powershell.exe', args)
    const parsed = parseWindowsProcessSample(stdout)
    return parsed.rows.length > 0 ? { ...parsed, sampledAtMs: performance.now() } : null
  } catch (err) {
    console.warn('[memory] PowerShell process enumeration failed; falling back to typeperf', err)
    return null
  }
}

async function enumerateWindowsWithTypeperf(): Promise<WindowsProcessResourceRow[]> {
  try {
    // Why: an immediate sample keeps the memory-only fallback inside the
    // Resource Manager's two-second poll interval without inventing CPU rates.
    const stdout = await execFileText('typeperf.exe', [
      ...TYPEPERF_COUNTERS,
      '-sc',
      '1',
      '-si',
      '0'
    ])
    return parseTypeperfProcessOutput(stdout)
  } catch (err) {
    console.warn('[memory] typeperf process enumeration failed', err)
    return []
  }
}

async function execFileText(file: string, args: string[]): Promise<string> {
  const result = await runProcess({
    program: file,
    args,
    timeoutMs: PROCESS_QUERY_TIMEOUT_MS,
    maxOutputBytes: PROCESS_QUERY_MAX_BUFFER
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${file} exited ${result.code ?? 'on timeout'}`)
  }
  return result.stdout
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
