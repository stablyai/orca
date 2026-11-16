import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'

// Bundled helper reads phys_footprint via proc_pid_rusage in a few ms, so every 2 s resource poll can use it.
const HELPER_EXECUTABLE = 'orca-process-footprint'
// One `top` sample costs ~0.3-0.6 s of CPU, so without the helper the 2 s resource poll reuses it for this long.
export const DARWIN_FOOTPRINT_REFRESH_MS = 10_000
const SAMPLE_TIMEOUT_MS = 5_000
const SAMPLE_MAX_BUFFER = 4 * 1024 * 1024

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4
}

type FootprintSource = {
  program: string
  args: string[]
  refreshMs: number
  parse: (stdout: string) => Map<number, number>
}

let cache: { sampledAt: number; footprints: ReadonlyMap<number, number> } | null = null
let inflight: Promise<ReadonlyMap<number, number> | null> | null = null
let helperAvailable: boolean | undefined
let supported = true

/** Parses the helper's `<pid> <bytes>` lines. */
export function parseHelperFootprints(stdout: string): Map<number, number> {
  const footprints = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const match = /^(\d+) (\d+)$/.exec(line.trim())
    if (match) {
      footprints.set(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10))
    }
  }
  return footprints
}

/** Parses `top -l 1 -stats pid,mem`; MEM is phys_footprint, the figure Activity Monitor shows. */
export function parseTopFootprints(stdout: string): Map<number, number> {
  const footprints = new Map<number, number>()
  let inTable = false
  for (const line of stdout.split('\n')) {
    if (!inTable) {
      inTable = /^\s*PID\s+MEM\s*$/.test(line)
      continue
    }
    const match = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line)
    if (!match) {
      continue
    }
    const bytes = Number.parseFloat(match[2]) * UNIT_BYTES[match[3]]
    if (Number.isFinite(bytes) && bytes >= 0) {
      footprints.set(Number.parseInt(match[1], 10), Math.round(bytes))
    }
  }
  return footprints
}

const TOP_SOURCE: FootprintSource = {
  program: '/usr/bin/top',
  args: ['-l', '1', '-stats', 'pid,mem'],
  refreshMs: DARWIN_FOOTPRINT_REFRESH_MS,
  parse: parseTopFootprints
}

function currentSource(): FootprintSource {
  const helperPath = join(dirname(process.execPath), HELPER_EXECUTABLE)
  helperAvailable ??= existsSync(helperPath)
  return helperAvailable
    ? { program: helperPath, args: [], refreshMs: 0, parse: parseHelperFootprints }
    : TOP_SOURCE
}

/** Per-pid physical footprint on macOS, or null when unavailable (callers fall back to RSS). */
export async function readDarwinProcessFootprints(
  now = Date.now()
): Promise<ReadonlyMap<number, number> | null> {
  if (!supported) {
    return null
  }
  const source = currentSource()
  if (cache && now - cache.sampledAt < source.refreshMs) {
    return cache.footprints
  }
  inflight ??= sampleFootprints(source).finally(() => {
    inflight = null
  })
  return inflight
}

async function sampleFootprints(
  source: FootprintSource
): Promise<ReadonlyMap<number, number> | null> {
  const footprints = await runSource(source)
  if (footprints) {
    cache = { sampledAt: Date.now(), footprints }
    return footprints
  }
  // A transient failure keeps the last good sample; a source that never answered is dropped.
  if (cache) {
    return cache.footprints
  }
  if (source !== TOP_SOURCE) {
    // A broken helper (quarantined, wrong arch) degrades to the slower top path rather than RSS.
    helperAvailable = false
    return sampleFootprints(TOP_SOURCE)
  }
  supported = false
  return null
}

async function runSource(source: FootprintSource): Promise<Map<number, number> | null> {
  try {
    const result = await runProcess({
      program: source.program,
      args: source.args,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: SAMPLE_MAX_BUFFER,
      timeoutMs: SAMPLE_TIMEOUT_MS
    })
    const footprints = result.code === 0 && !result.timedOut ? source.parse(result.stdout) : null
    return footprints && footprints.size > 0 ? footprints : null
  } catch {
    // Restricted hosts may lack the helper or top; callers fall back.
    return null
  }
}
