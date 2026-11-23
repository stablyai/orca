import { startSpan, type ActiveSpan } from '../../../observability/tracer'
import type { CrewFacet } from './crew-changes'
import { createCrewHostDerivation, type CrewHostDerivation } from './crew-host-derivation'
import type { CrewReadDependencies } from './crew-read-dependencies'

export type CrewRebuildTrigger =
  | 'first-subscribe'
  | 'one-shot'
  | 'topology'
  | 'records'
  | 'clock'
  | 'expiry'
  | 'status-identity'
  | 'stale-dispatch'

/** Why a full rebuild runs, from what the read found. */
export function crewRebuildTrigger(
  previous: { now: number } | undefined,
  listening: boolean,
  dirty: ReadonlySet<CrewFacet>,
  now: number,
  cause?: CrewRebuildTrigger
): CrewRebuildTrigger {
  if (!previous) {
    return listening ? 'first-subscribe' : 'one-shot'
  }
  if (cause) {
    return cause
  }
  if (dirty.has('topology')) {
    return 'topology'
  }
  if (dirty.has('records')) {
    return 'records'
  }
  return now < previous.now ? 'clock' : 'expiry'
}

/** Builds hosts for one read model. Each rebuild is recorded in the main-process trace (a no-op span
 *  without a sink) once the read that needed it settles: a host's source reads run lazily during the
 *  first snapshot, so that snapshot is part of the rebuild's cost. */
export function crewHostBuilder(listeners: () => number) {
  let rebuilds = 0
  let pending: { span: ActiveSpan; started: number; host: CrewHostDerivation } | undefined
  const settle = () => {
    if (!pending) {
      return
    }
    const { span, started, host } = pending
    pending = undefined
    span.setAttribute('elapsedMs', Math.round(performance.now() - started))
    span.setAttribute('assignments', host.assignmentsById.size)
    span.setAttribute('statuses', host.deps.statuses.length)
    span.setAttribute('listeners', listeners())
    span.setAttribute('rebuilds', ++rebuilds)
    span.end()
  }
  const build = (trigger: CrewRebuildTrigger, deps: CrewReadDependencies): CrewHostDerivation => {
    settle()
    const span = startSpan('orchestration.crew.rebuild', { attributes: { trigger } })
    const started = performance.now()
    let host: CrewHostDerivation
    try {
      host = createCrewHostDerivation(deps, () => Math.max(32, listeners() * 2))
    } catch (error) {
      span.fail(error instanceof Error ? error : String(error))
      throw error
    }
    pending = { span, started, host }
    return host
  }
  return { build, settle }
}
