/**
 * Text parsers for the two Windows process-table formats the memory collector
 * reads: tab-delimited `Get-CimInstance Win32_Process` rows and one Typeperf
 * CSV sample. Kept apart from the backend/CPU-delta orchestration so each side
 * stays readable on its own.
 */

import {
  iterateProcessOutputLines,
  PROCESS_OUTPUT_FIELD_SCAN_MAX_CHARS
} from '../../shared/process-output-field-scanner'

/**
 * Counter paths typeperf is asked for, kept beside the decoder that reads their
 * names back out of the PDH header.
 */
export const TYPEPERF_COUNTERS = [
  '\\Process(*)\\ID Process',
  '\\Process(*)\\Creating Process ID',
  '\\Process(*)\\Working Set',
  '\\Process(*)\\Private Bytes'
] as const

const TYPEPERF_MAX_INSTANCES = 4_096
// Why derived: PDH emits one field per counter per instance plus a timestamp, so
// a fixed cap silently shrinks the parsable process count each time a counter is
// added. The 1 MB line cap bounds memory independently.
const TYPEPERF_MAX_FIELDS = 1 + TYPEPERF_COUNTERS.length * TYPEPERF_MAX_INSTANCES
const TYPEPERF_MAX_LINE_CHARS = 1024 * 1024

export type WindowsProcessResourceRow = {
  pid: number
  ppid: number
  /** Percent of one core (may exceed 100 on multi-core). */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  /** Committed private bytes, resident or paged out. Absent when the host did not report it. */
  privateMemory?: number
}

export type WindowsCpuTimes = {
  cpuTicks: bigint
  startTimeId: string
}

export type ParsedWindowsProcessSample = {
  rows: WindowsProcessResourceRow[]
  cpuByPid: Map<number, WindowsCpuTimes>
}

type TypeperfProcessFields = {
  pid?: number
  ppid?: number
  memory?: number
  privateMemory?: number
}

export function parseWindowsProcessSample(stdout: string): ParsedWindowsProcessSample {
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
    const privateMemory = parseCimPageFileBytes(fields[6])
    rows.push({
      pid,
      ppid,
      cpu: 0,
      memory: Number.isFinite(memory) && memory > 0 ? memory : 0,
      ...(privateMemory === null ? {} : { privateMemory })
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
  return line.split('\t', 7).map((field) => field.trim())
}

/**
 * Win32_Process.PageFileUsage is a UInt32 of KILOBYTES. null (not 0) when the
 * property is missing, because a host that cannot report commit must not be
 * indistinguishable from a process holding none.
 */
function parseCimPageFileBytes(field: string | undefined): number | null {
  if (!field) {
    return null
  }
  const kb = Number.parseInt(field, 10)
  return Number.isSafeInteger(kb) && kb >= 0 ? kb * 1024 : null
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
    } else if (path.counter === 'Private Bytes') {
      row.privateMemory = value
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
      memory: row.memory !== undefined && row.memory > 0 ? row.memory : 0,
      ...(row.privateMemory !== undefined && row.privateMemory >= 0
        ? { privateMemory: row.privateMemory }
        : {})
    })
  }
  return rows
}

function parseTypeperfCounterPath(path: string): { instance: string; counter: string } | null {
  const processStart = path.lastIndexOf('\\Process(')
  const counterStart = path.lastIndexOf(')\\')
  if (processStart === -1 || counterStart <= processStart + 9) {
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
