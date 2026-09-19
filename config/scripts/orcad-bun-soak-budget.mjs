import { existsSync, readdirSync } from 'node:fs'

const DEFAULT_CYCLES = 1
const DEFAULT_MAX_RSS_GROWTH_MIB = 96
const MAX_CYCLES = 10_000
const MAX_RSS_GROWTH_MIB = 4_096
const MAX_HEAP_GROWTH_BYTES = 32 * 1024 * 1024
const MAX_DESCRIPTOR_GROWTH = 4

function readPositiveInteger(name, raw, maximum) {
  if (!/^\d+$/.test(String(raw))) {
    throw new Error(`${name} must be a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

export function parseOrcadBunSoakOptions(argv, env = process.env) {
  let cycles = env.ORCA_ORCAD_BUN_SOAK_CYCLES ?? DEFAULT_CYCLES
  let maxRssGrowthMib = env.ORCA_ORCAD_BUN_SOAK_MAX_RSS_GROWTH_MIB ?? DEFAULT_MAX_RSS_GROWTH_MIB
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    }
    if (arg === '--cycles' || arg === '--max-rss-growth-mib') {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error(`${arg} requires a value`)
      }
      if (arg === '--cycles') {
        cycles = value
      } else {
        maxRssGrowthMib = value
      }
      index += 1
      continue
    }
    if (arg.startsWith('--cycles=')) {
      cycles = arg.slice('--cycles='.length)
      continue
    }
    if (arg.startsWith('--max-rss-growth-mib=')) {
      maxRssGrowthMib = arg.slice('--max-rss-growth-mib='.length)
      continue
    }
    throw new Error(`Unknown orcad Bun soak argument: ${arg}`)
  }
  return {
    cycles: readPositiveInteger('--cycles', cycles, MAX_CYCLES),
    maxRssGrowthBytes:
      readPositiveInteger('--max-rss-growth-mib', maxRssGrowthMib, MAX_RSS_GROWTH_MIB) * 1024 * 1024
  }
}

function readOpenDescriptorCount() {
  const directory =
    process.platform === 'linux'
      ? '/proc/self/fd'
      : process.platform === 'darwin'
        ? '/dev/fd'
        : null
  if (!directory || !existsSync(directory)) {
    return null
  }
  return readdirSync(directory).length
}

export async function sampleOrcadBunSoakResources(cycle) {
  globalThis.Bun?.gc?.(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const memory = process.memoryUsage()
  return {
    cycle,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    openDescriptors: readOpenDescriptorCount()
  }
}

export function evaluateOrcadBunSoakBudget(samples, maxRssGrowthBytes) {
  if (samples.length === 0) {
    throw new Error('orcad Bun soak produced no resource samples')
  }
  const baseline = samples[0]
  const peakRssBytes = Math.max(...samples.map((sample) => sample.rssBytes))
  const peakHeapUsedBytes = Math.max(...samples.map((sample) => sample.heapUsedBytes))
  const descriptorSamples = samples
    .map((sample) => sample.openDescriptors)
    .filter((value) => value !== null)
  const peakOpenDescriptors = descriptorSamples.length > 0 ? Math.max(...descriptorSamples) : null
  const rssGrowthBytes = Math.max(0, peakRssBytes - baseline.rssBytes)
  const heapGrowthBytes = Math.max(0, peakHeapUsedBytes - baseline.heapUsedBytes)
  const descriptorGrowth =
    peakOpenDescriptors === null || baseline.openDescriptors === null
      ? null
      : Math.max(0, peakOpenDescriptors - baseline.openDescriptors)
  const failures = [
    rssGrowthBytes <= maxRssGrowthBytes ||
      `RSS grew by ${rssGrowthBytes} bytes after the warm cycle`,
    heapGrowthBytes <= MAX_HEAP_GROWTH_BYTES ||
      `heap grew by ${heapGrowthBytes} bytes after the warm cycle`,
    descriptorGrowth === null ||
      descriptorGrowth <= MAX_DESCRIPTOR_GROWTH ||
      `open descriptors grew by ${descriptorGrowth} after the warm cycle`
  ].filter((result) => result !== true)
  return {
    baseline,
    final: samples.at(-1),
    peakRssBytes,
    peakHeapUsedBytes,
    peakOpenDescriptors,
    rssGrowthBytes,
    heapGrowthBytes,
    descriptorGrowth,
    failures
  }
}
