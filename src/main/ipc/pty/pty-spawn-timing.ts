import { startSpan } from '../../observability/tracer'

// Opt-in phase timing attributes spawn latency without tracing; mark actual spans to avoid blaming env assembly for auth/hook prep.

export type PtySpawnTiming = {
  mark(phase: string): void
  log(id: string, extra?: Record<string, string | number | boolean>): void
}

const noopTiming: PtySpawnTiming = {
  mark: () => undefined,
  log: () => undefined
}

export function createPtySpawnTiming(): PtySpawnTiming {
  const flag = process.env.ORCA_PTY_SPAWN_TIMING
  if (!flag || flag === '0' || flag.toLowerCase() === 'false') {
    return noopTiming
  }
  const startedAt = performance.now()
  let lastAt = startedAt
  const phases: string[] = []
  const phaseDurations: Record<string, number> = {}
  return {
    mark(phase: string): void {
      const now = performance.now()
      const elapsed = now - lastAt
      phases.push(`${phase}=${Math.round(elapsed)}ms`)
      phaseDurations[phase] = elapsed
      lastAt = now
    },
    log(id: string, extra?: Record<string, string | number | boolean>): void {
      const totalMs = performance.now() - startedAt
      const extras = extra
        ? ` ${Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')}`
        : ''
      try {
        startSpan('pty.spawn.timing', {
          attributes: { ptyId: id, totalMs, phaseDurations, ...extra }
        }).end()
      } catch {
        // Optional diagnostics must not reject a successful spawn.
      }
      console.log(
        `[pty-spawn-timing] id=${id} total=${Math.round(totalMs)}ms ${phases.join(' ')}${extras}`
      )
    }
  }
}
