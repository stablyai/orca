import { execFileSync } from 'node:child_process'

const SAMPLE_COUNT = 5
const SAMPLE_INTERVAL_MS = 200

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

function parseCpuTimeSeconds(value) {
  const [dayOrTime, clock] = value.includes('-') ? value.split('-', 2) : [null, value]
  const days = dayOrTime === null ? 0 : Number(dayOrTime)
  const parts = clock.split(':').map(Number)
  if (!Number.isFinite(days) || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid process CPU time: ${value}`)
  }
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export function processSnapshot(pid) {
  const raw = execFileSync(
    'ps',
    ['-o', 'rss=', '-o', 'time=', '-o', 'command=', '-p', String(pid)],
    { encoding: 'utf8' }
  ).trim()
  const match = raw.match(/^(\d+)\s+(\S+)\s+(.+)$/)
  if (!match) {
    throw new Error(`Could not inspect process ${pid}: ${raw}`)
  }
  return {
    rssBytes: Number(match[1]) * 1024,
    cpuTimeSeconds: parseCpuTimeSeconds(match[2]),
    command: match[3]
  }
}

export async function sampleProcess(pid) {
  const samples = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(processSnapshot(pid))
    await sleep(SAMPLE_INTERVAL_MS)
  }
  return {
    rssBytes: median(samples.map((sample) => sample.rssBytes)),
    cpuTimeSeconds: samples.at(-1).cpuTimeSeconds,
    command: samples.at(-1).command
  }
}
