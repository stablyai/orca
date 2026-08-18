import { execFileSync, spawnSync } from 'node:child_process'

function parseCpuTimeSeconds(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    return null
  }
  const [dayOrTime, maybeTime] = trimmed.includes('-') ? trimmed.split('-', 2) : [null, trimmed]
  const days = dayOrTime === null ? 0 : Number(dayOrTime)
  const parts = maybeTime.split(':').map(Number)
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) {
    return null
  }
  if (parts.length === 3) {
    return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  if (parts.length === 2) {
    return days * 86400 + parts[0] * 60 + parts[1]
  }
  if (parts.length === 1) {
    return days * 86400 + parts[0]
  }
  return null
}

function parseUnixProcesses(stdout) {
  const rows = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      percentCpu: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      cpuTimeSeconds: parseCpuTimeSeconds(match[5]),
      command: match[6]
    })
  }
  return rows
}

function readUnixProcesses() {
  const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,cputime=,command='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    maxBuffer: 20 * 1024 * 1024
  })
  return parseUnixProcesses(stdout)
}

function readWindowsProcesses() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'PowerShell process enumeration failed')
  }
  const parsed = JSON.parse(result.stdout || '[]')
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map((entry) => ({
    pid: Number(entry.ProcessId),
    ppid: Number(entry.ParentProcessId),
    percentCpu: 0,
    cpuTimeSeconds: null,
    rssBytes: Number(entry.WorkingSetSize) || 0,
    command: String(entry.CommandLine || '')
  }))
}

export function readProcessRows() {
  return process.platform === 'win32' ? readWindowsProcesses() : readUnixProcesses()
}

export function descendantsOf(rows, rootPid) {
  const children = new Map()
  for (const row of rows) {
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const result = []
  const stack = [rootPid]
  const seen = new Set()
  while (stack.length > 0) {
    const pid = stack.pop()
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    const row = rows.find((candidate) => candidate.pid === pid)
    if (row) {
      result.push(row)
    }
    for (const child of children.get(pid) ?? []) {
      stack.push(child.pid)
    }
  }
  return result
}

export function classify(row, rootPid) {
  const command = row.command.toLowerCase()
  if (row.pid === rootPid) {
    return 'main'
  }
  if (command.includes('daemon-entry')) {
    return 'daemon'
  }
  if (command.includes('--type=gpu-process')) {
    return 'gpu'
  }
  if (command.includes('--type=renderer')) {
    return 'renderer'
  }
  if (command.includes('--type=utility')) {
    return 'utility'
  }
  if (command.includes('--type=')) {
    return 'electron-other'
  }
  if (command.includes('node') || command.includes('/pi') || command.endsWith(' pi')) {
    return 'agent-or-node'
  }
  return 'other-descendant'
}

const DEFAULT_WORKLOAD_OVERRUN_LIMIT_MS = 120_000

export async function sampleProcessTreeUntilWorkloadsComplete({
  rootPid,
  requestedDurationMs,
  intervalMs,
  workloadPromise,
  maxWorkloadOverrunMs = DEFAULT_WORKLOAD_OVERRUN_LIMIT_MS,
  readRows = readProcessRows,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const samplingStartedAt = now()
  const requestedDeadline = samplingStartedAt + requestedDurationMs
  const hardDeadline = requestedDeadline + maxWorkloadOverrunMs
  let workloadSettled = false
  let workloadResult
  let workloadError
  let workloadSettledAt = null
  void workloadPromise.then(
    (result) => {
      workloadResult = result
      workloadSettled = true
      workloadSettledAt = now()
    },
    (error) => {
      workloadError = error
      workloadSettled = true
      workloadSettledAt = now()
    }
  )
  const samples = []
  let previousSnapshot = null
  const needsFinalWorkloadSample = () =>
    workloadSettledAt !== null && (previousSnapshot?.at ?? -Infinity) < workloadSettledAt
  while (
    now() <= requestedDeadline ||
    samples.length === 0 ||
    !workloadSettled ||
    needsFinalWorkloadSample()
  ) {
    const sampledAt = now()
    if (workloadError) {
      throw workloadError
    }
    if (
      (!workloadSettled && sampledAt >= hardDeadline) ||
      (workloadSettledAt !== null && workloadSettledAt > hardDeadline)
    ) {
      throw new Error(
        `Benchmark workload exceeded the ${maxWorkloadOverrunMs}ms sampling overrun limit`
      )
    }
    const processRows = descendantsOf(readRows(), rootPid)
    const rawProcesses = processRows.map((row) => ({ ...row, kind: classify(row, rootPid) }))
    if (previousSnapshot) {
      const elapsedSeconds = Math.max(0.001, (sampledAt - previousSnapshot.at) / 1000)
      const previousByPid = new Map(previousSnapshot.processes.map((proc) => [proc.pid, proc]))
      const processes = rawProcesses.map((row) => {
        const previous = previousByPid.get(row.pid)
        const canComputeDelta =
          typeof row.cpuTimeSeconds === 'number' && typeof previous?.cpuTimeSeconds === 'number'
        const cpu = canComputeDelta
          ? Math.max(0, ((row.cpuTimeSeconds - previous.cpuTimeSeconds) / elapsedSeconds) * 100)
          : row.percentCpu
        return { ...row, cpu }
      })
      samples.push({
        at: sampledAt,
        elapsedMs: sampledAt - previousSnapshot.at,
        totalCpuPercent: processes.reduce((sum, proc) => sum + proc.cpu, 0),
        totalRssBytes: processes.reduce((sum, proc) => sum + proc.rssBytes, 0),
        processes
      })
    }
    previousSnapshot = { at: sampledAt, processes: rawProcesses }
    await wait(intervalMs)
  }
  if (workloadError) {
    throw workloadError
  }
  const measuredDurationMs = Math.max(
    0,
    (previousSnapshot?.at ?? samplingStartedAt) - samplingStartedAt
  )
  return {
    samples,
    workloadResult,
    samplingWindow: {
      requestedDurationMs,
      measuredDurationMs,
      maxWorkloadOverrunMs,
      extendedForWorkload: workloadSettledAt !== null && workloadSettledAt > requestedDeadline,
      workloadSettledElapsedMs:
        workloadSettledAt === null ? null : Math.max(0, workloadSettledAt - samplingStartedAt),
      workloadSettledBeforeStop: workloadSettled
    }
  }
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  return sorted[index]
}

export function summarizeSamples(samples) {
  const byKind = new Map()
  for (const sample of samples) {
    for (const proc of sample.processes) {
      const bucket = byKind.get(proc.kind) ?? { cpuValues: [], rssValues: [], maxProcessCount: 0 }
      bucket.cpuValues.push(proc.cpu)
      bucket.rssValues.push(proc.rssBytes)
      byKind.set(proc.kind, bucket)
    }
    const counts = new Map()
    for (const proc of sample.processes) {
      counts.set(proc.kind, (counts.get(proc.kind) ?? 0) + 1)
    }
    for (const [kind, count] of counts) {
      byKind.get(kind).maxProcessCount = Math.max(byKind.get(kind).maxProcessCount, count)
    }
  }
  const summary = {}
  for (const [kind, values] of byKind) {
    const cpuSorted = [...values.cpuValues].sort((a, b) => a - b)
    const rssSumBySample = samples.map((sample) =>
      sample.processes
        .filter((proc) => proc.kind === kind)
        .reduce((sum, proc) => sum + proc.rssBytes, 0)
    )
    summary[kind] = {
      meanCpuPercent: mean(values.cpuValues),
      p95CpuPercent: percentile(cpuSorted, 0.95),
      maxCpuPercent: Math.max(0, ...values.cpuValues),
      meanRssBytes: mean(rssSumBySample),
      maxProcessCount: values.maxProcessCount
    }
  }
  summary.total = {
    meanCpuPercent: mean(samples.map((sample) => sample.totalCpuPercent)),
    p95CpuPercent: percentile(
      samples.map((sample) => sample.totalCpuPercent).sort((a, b) => a - b),
      0.95
    ),
    meanRssBytes: mean(samples.map((sample) => sample.totalRssBytes))
  }
  return summary
}

export function summarizeProcessInventory(samples) {
  const inventory = {}
  for (const sample of samples) {
    const counts = new Map()
    for (const proc of sample.processes) {
      counts.set(proc.kind, (counts.get(proc.kind) ?? 0) + 1)
      const entry = inventory[proc.kind] ?? {
        maxProcessCount: 0,
        maxCpuPercent: 0,
        commandSamples: []
      }
      entry.maxCpuPercent = Math.max(entry.maxCpuPercent, proc.cpu)
      if (!entry.commandSamples.includes(proc.command) && entry.commandSamples.length < 6) {
        entry.commandSamples.push(proc.command)
      }
      inventory[proc.kind] = entry
    }
    for (const [kind, count] of counts) {
      inventory[kind].maxProcessCount = Math.max(inventory[kind].maxProcessCount, count)
    }
  }
  return inventory
}

export function terminateProcesses(processes) {
  for (const proc of processes) {
    try {
      process.kill(proc.pid)
    } catch {}
  }
}
