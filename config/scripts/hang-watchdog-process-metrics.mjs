import { execFileSync } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export async function sampleMemory(readRss, readPhysicalFootprint, options) {
  const rssSamples = []
  const physicalFootprintSamples = []
  for (let index = 0; index < options.sampleCount; index += 1) {
    rssSamples.push(readRss())
    physicalFootprintSamples.push(readPhysicalFootprint())
    await options.sleep(options.sampleIntervalMs)
  }
  return {
    rssBytes: median(rssSamples),
    physicalFootprintBytes: median(physicalFootprintSamples)
  }
}

export function childRssBytes(pid) {
  const raw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8'
  }).trim()
  const rssKiB = Number(raw)
  if (!Number.isFinite(rssKiB) || rssKiB <= 0) {
    throw new Error(`Could not read watchdog child RSS for PID ${pid}`)
  }
  return rssKiB * 1024
}

export function parsePhysicalFootprintBytes(output, processCount) {
  const match =
    processCount > 1
      ? output.match(/^Summary Footprint:\s+(\d+) B$/m)
      : output.match(/^[^\s].*\sFootprint:\s+(\d+) B/m)
  const bytes = Number(match?.[1])
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null
}

export function physicalFootprintBytes(pids) {
  const pidArgs = pids.flatMap((pid) => ['--pid', String(pid)])
  const output = execFileSync(
    '/usr/bin/footprint',
    [...pidArgs, '--format', 'bytes', '--noCategories'],
    { encoding: 'utf8' }
  )
  const bytes = parsePhysicalFootprintBytes(output, pids.length)
  if (bytes === null) {
    throw new Error(`Could not read physical footprint for PIDs ${pids.join(', ')}`)
  }
  return bytes
}

export function parseProcessCpuTimeMs(raw) {
  if (!raw.trim()) {
    return null
  }
  const parts = raw.split(':').map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) {
    return null
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  const milliseconds = seconds * 1_000
  return milliseconds >= 0 ? milliseconds : null
}

function processCpuTimeMs(pid) {
  const raw = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], {
    encoding: 'utf8'
  }).trim()
  const milliseconds = parseProcessCpuTimeMs(raw)
  if (milliseconds === null) {
    throw new Error(`Could not read CPU time for PID ${pid}`)
  }
  return milliseconds
}

function combinedCpuTimeMs(pids) {
  return pids.reduce((total, pid) => total + processCpuTimeMs(pid), 0)
}

export async function sampleProductionPerformance(boundary, options) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  let heartbeatCount = 0
  const heartbeat = setInterval(() => {
    heartbeatCount += 1
    boundary.sendHeartbeat()
  }, options.heartbeatIntervalMs)
  const cpuBefore = combinedCpuTimeMs(boundary.pids)
  loopDelay.enable()
  try {
    await options.sleep(options.sampleMs)
  } finally {
    loopDelay.disable()
    clearInterval(heartbeat)
  }
  return {
    cpuMs: Math.max(0, combinedCpuTimeMs(boundary.pids) - cpuBefore),
    heartbeatCount,
    eventLoopDelayP95Ms: loopDelay.percentile(95) / 1e6,
    eventLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    eventLoopDelayMaxMs: loopDelay.max / 1e6
  }
}
