import { execFile } from 'node:child_process'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  iterateProcessOutputLines,
  PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS
} from '../../shared/process-output-field-scanner'

const PROCESS_QUERY_TIMEOUT_MS = 5_000
const PROCESS_QUERY_MAX_BUFFER = 10 * 1024 * 1024
const TYPEPERF_COUNTERS = [
  '\\Process(*)\\ID Process',
  '\\Process(*)\\Creating Process ID',
  '\\Process(*)\\Working Set'
] as const
const TYPEPERF_MAX_FIELDS = 8_192
const TYPEPERF_MAX_LINE_CHARS = 1024 * 1024
const CPU_MIN_SAMPLE_MS = 250
const CPU_STALE_AFTER_MS = 10_000
const HUNDRED_NS_TICKS_PER_MS = 10_000
const CIM_RETRY_AFTER_MS = 30_000

export type WindowsProcessResourceRow = {
  pid: number
  ppid: number
  /** Percent of one core (may exceed 100 on multi-core). */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
}

type WindowsCpuTimes = {
  cpuTicks: bigint
  startTimeId: string
}

type WindowsProcessSample = {
  sampledAtMs: number
  rows: WindowsProcessResourceRow[]
  cpuByPid: Map<number, WindowsCpuTimes>
}

type ParsedWindowsProcessSample = Omit<WindowsProcessSample, 'sampledAtMs'>

type TypeperfProcessFields = {
  pid?: number
  ppid?: number
  memory?: number
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
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; " +
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate | ' +
      'ForEach-Object { try { [string]::Join([char]9, @($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, [string]$_.KernelModeTime, [string]$_.UserModeTime, $_.CreationDate.ToUniversalTime().Ticks)) } catch {} }'
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

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        maxBuffer: PROCESS_QUERY_MAX_BUFFER,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true
      },
      (err, output) => {
        if (err) {
          reject(err)
          return
        }
        resolve(String(output))
      }
    )
  })
}

function parseWindowsProcessSample(stdout: string): ParsedWindowsProcessSample {
  const rows: WindowsProcessResourceRow[] = []
  const cpuByPid = new Map<number, WindowsCpuTimes>()
  for (const line of iterateProcessOutputLines(stdout)) {
    const fields = parseCimTabFields(line)
    if (fields.length < 3) {
      continue
    }
    const pid = Number.parseInt(fields[0], 10)
    const ppid = Number.parseInt(fields[1], 10)
    const memory = Number.parseInt(fields[2], 10)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      continue
    }
    rows.push({
      pid,
      ppid,
      cpu: 0,
      memory: Number.isFinite(memory) && memory > 0 ? memory : 0
    })

    const kernelTicks = parseUnsignedBigInt(fields[3])
    const userTicks = parseUnsignedBigInt(fields[4])
    const startTimeId = fields[5] ?? ''
    if (
      kernelTicks !== null &&
      userTicks !== null &&
      /^\d+$/.test(startTimeId) &&
      !/^0+$/.test(startTimeId)
    ) {
      cpuByPid.set(pid, { cpuTicks: kernelTicks + userTicks, startTimeId })
    }
  }
  return { rows, cpuByPid }
}

function parseCimTabFields(line: string): string[] {
  // Why: CIM serializes null properties as empty tab fields; collapsing
  // whitespace would shift CPU counters into the working-set column.
  if (line.length > PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS) {
    return []
  }
  return line.split('\t', 6).map((field) => field.trim())
}

/** Parse tab-delimited PowerShell CIM process rows without deriving CPU deltas. */
export function parseWindowsProcessOutput(stdout: string): WindowsProcessResourceRow[] {
  return parseWindowsProcessSample(stdout).rows
}

/** Parse one CSV sample from Windows Typeperf. */
export function parseTypeperfProcessOutput(stdout: string): WindowsProcessResourceRow[] {
  let headers: string[] | null = null
  let values: string[] | null = null

  for (const line of iterateProcessOutputLines(stdout)) {
    if (!line || line.length > TYPEPERF_MAX_LINE_CHARS) {
      continue
    }
    const fields = parseTypeperfCsvLine(line)
    if (!headers && fields[0]?.startsWith('(PDH-CSV')) {
      headers = fields
      continue
    }
    if (headers && fields.length === headers.length) {
      values = fields
      break
    }
  }

  if (!headers || !values) {
    return []
  }

  const byInstance = new Map<string, TypeperfProcessFields>()
  for (let index = 1; index < headers.length; index += 1) {
    const path = parseTypeperfCounterPath(headers[index])
    if (!path || path.instance === '_Total') {
      continue
    }
    const value = Number.parseFloat(values[index])
    if (!Number.isFinite(value)) {
      continue
    }
    const row = byInstance.get(path.instance) ?? {}
    if (path.counter === 'ID Process') {
      row.pid = Math.trunc(value)
    } else if (path.counter === 'Creating Process ID') {
      row.ppid = Math.trunc(value)
    } else if (path.counter === 'Working Set') {
      row.memory = value
    }
    byInstance.set(path.instance, row)
  }

  const rows: WindowsProcessResourceRow[] = []
  for (const row of byInstance.values()) {
    if (row.pid === undefined || row.pid <= 0 || row.ppid === undefined || row.ppid < 0) {
      continue
    }
    rows.push({
      pid: row.pid,
      ppid: row.ppid,
      cpu: 0,
      memory: row.memory !== undefined && row.memory > 0 ? row.memory : 0
    })
  }
  return rows
}

function parseTypeperfCounterPath(path: string): { instance: string; counter: string } | null {
  const processStart = path.lastIndexOf('\\Process(')
  const counterStart = path.lastIndexOf(')\\')
  if (processStart < 0 || counterStart <= processStart + 9) {
    return null
  }
  return {
    instance: path.slice(processStart + 9, counterStart),
    counter: path.slice(counterStart + 2)
  }
}

function parseTypeperfCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (char === ',' && !quoted) {
      fields.push(value)
      value = ''
      if (fields.length >= TYPEPERF_MAX_FIELDS) {
        return []
      }
      continue
    }
    value += char
  }
  fields.push(value)
  return fields
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

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}
