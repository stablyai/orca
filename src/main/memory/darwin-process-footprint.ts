import { runProcess } from '@orca/process-host'

// One `top` sample walks every process (~0.6 s of CPU), so the 2 s resource poll reuses it for this long.
export const DARWIN_FOOTPRINT_REFRESH_MS = 10_000
const TOP_TIMEOUT_MS = 5_000
const TOP_MAX_BUFFER = 4 * 1024 * 1024

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4
}

let cache: { sampledAt: number; footprints: ReadonlyMap<number, number> } | null = null
let inflight: Promise<ReadonlyMap<number, number> | null> | null = null
let supported = true

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

/** Per-pid physical footprint on macOS, or null when unavailable (callers fall back to RSS). */
export async function readDarwinProcessFootprints(
  now = Date.now()
): Promise<ReadonlyMap<number, number> | null> {
  if (!supported) {
    return null
  }
  if (cache && now - cache.sampledAt < DARWIN_FOOTPRINT_REFRESH_MS) {
    return cache.footprints
  }
  inflight ??= sampleFootprints().finally(() => {
    inflight = null
  })
  return inflight
}

async function sampleFootprints(): Promise<ReadonlyMap<number, number> | null> {
  try {
    const result = await runProcess({
      program: '/usr/bin/top',
      args: ['-l', '1', '-stats', 'pid,mem'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: TOP_MAX_BUFFER,
      timeoutMs: TOP_TIMEOUT_MS
    })
    const footprints =
      result.code === 0 && !result.timedOut ? parseTopFootprints(result.stdout) : null
    if (footprints && footprints.size > 0) {
      cache = { sampledAt: Date.now(), footprints }
      return footprints
    }
  } catch {
    // Restricted hosts may lack top; RSS remains the fallback.
  }
  // A transient failure keeps the last good sample; a host that never answered stops trying.
  if (!cache) {
    supported = false
  }
  return cache?.footprints ?? null
}
