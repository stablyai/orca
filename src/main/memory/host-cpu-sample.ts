import type { CpuInfo } from 'node:os'
import type { HostResourcesSnapshot } from '../../shared/host-resources'

const CPU_SAMPLE_MAX_AGE_MS = 10_000
const CPU_RESAMPLE_WAIT_MS = 200
const CPU_MIN_BASELINE_WINDOW_MS = 1_000

export type CpuTimeSample = {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

export type HostCpuReaders = {
  now: () => number
  readCpus: () => CpuInfo[]
  wait: (ms: number) => Promise<void>
  platform: () => NodeJS.Platform
  loadavg: () => readonly number[]
}

type CpuTick = {
  at: number
  times: CpuTimeSample[]
  model: string
  coreCount: number
}

let cpuBaseline: { at: number; times: CpuTimeSample[] } | null = null

export function cpuPercentsFromDelta(
  previous: readonly CpuTimeSample[],
  current: readonly CpuTimeSample[]
): { percent: number | null; cores: { percent: number | null }[] } {
  const paired = Math.min(previous.length, current.length)
  return {
    percent: percentBusy(sumTimes(previous.slice(0, paired)), sumTimes(current.slice(0, paired))),
    cores: current.map((times, index) => {
      const prior = previous[index]
      return { percent: prior ? percentBusy(prior, times) : null }
    })
  }
}

export async function readHostCpu(readers: HostCpuReaders): Promise<HostResourcesSnapshot['cpu']> {
  const started = readCpuTick(readers)
  let baseline = cpuBaseline
  const stale =
    baseline === null ||
    started.at - baseline.at > CPU_SAMPLE_MAX_AGE_MS ||
    baseline.times.length !== started.times.length
  let current = started
  if (stale) {
    // One sample has no rate, and a baseline older than 10s is not a rate either.
    await readers.wait(CPU_RESAMPLE_WAIT_MS)
    current = readCpuTick(readers)
    baseline = { at: started.at, times: started.times }
  }
  const prior = baseline ?? started
  const usage = cpuPercentsFromDelta(prior.times, current.times)
  if (stale || current.at - prior.at >= CPU_MIN_BASELINE_WINDOW_MS) {
    cpuBaseline = { at: current.at, times: current.times }
  }
  return {
    percent: usage.percent,
    coreCount: current.coreCount,
    model: current.model,
    loadAverage1m: readLoadAverage(readers),
    cores: usage.cores
  }
}

function readCpuTick(readers: HostCpuReaders): CpuTick {
  const cpus = readers.readCpus()
  return {
    at: readers.now(),
    times: cpus.map((cpu) => ({
      user: cpu.times.user,
      nice: cpu.times.nice,
      sys: cpu.times.sys,
      idle: cpu.times.idle,
      irq: cpu.times.irq
    })),
    model: cpus[0]?.model ?? '',
    coreCount: Math.max(1, cpus.length)
  }
}

function readLoadAverage(readers: HostCpuReaders): number | null {
  // Node publishes a meaningless [0, 0, 0] load average on Windows.
  if (readers.platform() === 'win32') {
    return null
  }
  const value = readers.loadavg()[0]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function percentBusy(previous: CpuTimeSample, current: CpuTimeSample): number | null {
  const totalDelta = timesTotal(current) - timesTotal(previous)
  if (!(totalDelta > 0) || !Number.isFinite(current.idle - previous.idle)) {
    return null
  }
  return clampPercent(((totalDelta - (current.idle - previous.idle)) / totalDelta) * 100)
}

function sumTimes(samples: readonly CpuTimeSample[]): CpuTimeSample {
  const total: CpuTimeSample = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  for (const sample of samples) {
    total.user += sample.user
    total.nice += sample.nice
    total.sys += sample.sys
    total.idle += sample.idle
    total.irq += sample.irq
  }
  return total
}

function timesTotal(times: CpuTimeSample): number {
  const total = times.user + times.nice + times.sys + times.idle + times.irq
  return Number.isFinite(total) ? total : Number.NaN
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}
