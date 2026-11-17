// Clock-injected per-terminal descendant scopes permit future per-agent OS limits; host totals cover all scopes.

export type ProcessGrowthSample = {
  atMs: number
  /** Descendants of the whole host, or null when the table could not be read. */
  hostDescendants: number | null
  scopes: ReadonlyMap<string, number>
}

export type ProcessGrowthLimits = {
  /** A total this high is reported as elevated load; on its own it never trips. */
  hostElevatedDescendants: number
  /** New descendants per second, per scope or host-wide, that count as a storm. */
  growthPerSecond: number
  /** How long, and over how many consecutive rising samples, growth must hold to trip. */
  sustainMs: number
  minRisingSamples: number
}

export const DEFAULT_PROCESS_GROWTH_LIMITS: ProcessGrowthLimits = {
  hostElevatedDescendants: 1500,
  growthPerSecond: 40,
  sustainMs: 10_000,
  minRisingSamples: 3
}

export type ProcessGrowthTrip = {
  /** null: the host total; otherwise the scope whose tree grew. */
  scopeId: string | null
  descendants: number
  growthPerSecond: number
}

type RisingStreak = { since: number; samples: number }

export type ProcessGrowthState = {
  previous: ProcessGrowthSample | null
  /** Current rising streak per scope (`''` = host). */
  streaks: Map<string, RisingStreak>
}

export type ProcessGrowthVerdict = {
  level: 'ok' | 'elevated' | 'critical' | 'unknown'
  trips: ProcessGrowthTrip[]
  /** A rising streak is open somewhere; confirm it with short samples. */
  rising: boolean
}

const HOST_KEY = ''

export function createProcessGrowthState(): ProcessGrowthState {
  return { previous: null, streaks: new Map() }
}

function growthRate(previous: number | undefined, current: number, elapsedMs: number): number {
  return previous === undefined || elapsedMs <= 0 ? 0 : ((current - previous) * 1000) / elapsedMs
}

/** Trip only sustained growth, never high load or one long interval. Unknown samples neither trip nor clear streaks. */
export function evaluateProcessGrowth(
  state: ProcessGrowthState,
  sample: ProcessGrowthSample,
  limits: ProcessGrowthLimits
): ProcessGrowthVerdict {
  if (sample.hostDescendants === null) {
    return { level: 'unknown', trips: [], rising: state.streaks.size > 0 }
  }
  const previous = state.previous
  const elapsedMs = previous ? sample.atMs - previous.atMs : 0
  const trips: ProcessGrowthTrip[] = []
  let growing = false
  const observe = (key: string, before: number | undefined, current: number): void => {
    const rate = growthRate(before, current, elapsedMs)
    if (rate < limits.growthPerSecond) {
      state.streaks.delete(key)
      return
    }
    growing = true
    const streak = state.streaks.get(key) ?? { since: previous?.atMs ?? sample.atMs, samples: 0 }
    streak.samples += 1
    state.streaks.set(key, streak)
    if (
      streak.samples >= limits.minRisingSamples &&
      sample.atMs - streak.since >= limits.sustainMs
    ) {
      trips.push({
        scopeId: key === HOST_KEY ? null : key,
        descendants: current,
        growthPerSecond: Math.round(rate)
      })
    }
  }
  observe(HOST_KEY, previous?.hostDescendants ?? undefined, sample.hostDescendants)
  for (const [scopeId, count] of sample.scopes) {
    observe(scopeId, previous?.scopes.get(scopeId), count)
  }
  for (const key of state.streaks.keys()) {
    if (key !== HOST_KEY && !sample.scopes.has(key)) {
      state.streaks.delete(key)
    }
  }
  state.previous = sample
  if (trips.length > 0) {
    return { level: 'critical', trips, rising: true }
  }
  return {
    level: growing || sample.hostDescendants >= limits.hostElevatedDescendants ? 'elevated' : 'ok',
    trips,
    rising: growing
  }
}

/** Descendant counts per root pid from a pid/ppid table. */
export function countDescendantsByRoot(
  rows: readonly { pid: number; ppid: number }[],
  roots: readonly number[]
): Map<number, number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) {
      continue
    }
    const siblings = children.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      children.set(row.ppid, [row.pid])
    }
  }
  const counts = new Map<number, number>()
  for (const root of roots) {
    let count = 0
    const seen = new Set<number>([root])
    const stack = [...(children.get(root) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()
      if (pid === undefined || seen.has(pid)) {
        continue
      }
      seen.add(pid)
      count += 1
      stack.push(...(children.get(pid) ?? []))
    }
    counts.set(root, count)
  }
  return counts
}
