// Lane-side reader for the line orcad-startup-timing writes; kept out of orcad's own bundle.
import { ORCAD_STARTUP_TIMING_PREFIX } from './orcad-startup-timing'

export type OrcadStartupTimingReport = {
  readyMs: number
  phases: [name: string, startMs: number, endMs: number][]
}

export type OrcadStartupTimingMedians = {
  readyMs: number
  /** Process start to the first timed phase: Node boot plus the eager module graph. */
  bootMs: number
  phaseEndMs: Record<string, number>
  phaseMs: Record<string, number>
}

function isPhase(value: unknown): value is [string, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number'
  )
}

/** The report in a log line, or null when the line carries none. */
export function parseOrcadStartupTimingLine(line: string): OrcadStartupTimingReport | null {
  const at = line.indexOf(ORCAD_STARTUP_TIMING_PREFIX)
  if (at === -1) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(at + ORCAD_STARTUP_TIMING_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const readyMs = 'readyMs' in parsed ? parsed.readyMs : undefined
  const phases = 'phases' in parsed ? parsed.phases : undefined
  if (typeof readyMs !== 'number' || !Array.isArray(phases) || !phases.every(isPhase)) {
    return null
  }
  return { readyMs, phases }
}

function lowerMedian(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0
}

/** Per-key medians; a phase missing from any run is left out rather than skewing the median. */
export function medianOrcadStartupTiming(
  runs: readonly (OrcadStartupTimingReport | null)[]
): OrcadStartupTimingMedians | null {
  const measured = runs.filter((run): run is OrcadStartupTimingReport => run !== null)
  if (measured.length === 0) {
    return null
  }
  const phaseEndMs: Record<string, number> = {}
  const phaseMs: Record<string, number> = {}
  for (const [name] of measured[0].phases) {
    const found = measured.map((run) => run.phases.find(([other]) => other === name))
    if (found.every((phase) => phase !== undefined)) {
      phaseEndMs[name] = lowerMedian(found.map(([, , endMs]) => endMs))
      phaseMs[name] = lowerMedian(found.map(([, startMs, endMs]) => endMs - startMs))
    }
  }
  return {
    readyMs: lowerMedian(measured.map((run) => run.readyMs)),
    bootMs: lowerMedian(
      measured.map((run) => Math.min(...run.phases.map(([, startMs]) => startMs), run.readyMs))
    ),
    phaseEndMs,
    phaseMs
  }
}
