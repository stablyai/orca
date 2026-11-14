import type { JournalStopEvent } from '../durable-rows/journal-row-schema'

export type JournalPersonalStopFrontier = {
  sourceIdentity?: string | null
  boundary: number
  complete: boolean
  turns: Map<string | undefined, { sequence: number; at: number }>
}
export type JournalPersonalStopEvidence = 'stopped' | 'clear' | 'unknown'

export function emptyJournalPersonalStops(boundary = 1): JournalPersonalStopFrontier {
  return { boundary, complete: true, turns: new Map() }
}

/** Sequence and wall-clock maxima are independent when an old witness has no cursor. */
export function rememberJournalPersonalStop(
  frontier: JournalPersonalStopFrontier,
  sequence: number,
  event: JournalStopEvent
): void {
  if (
    sequence < frontier.boundary ||
    (event.reason !== 'user-stop' && event.reason !== 'user-close')
  ) {
    return
  }
  const prior = frontier.turns.get(event.turnId)
  frontier.turns.set(event.turnId, {
    sequence: Math.max(prior?.sequence ?? 0, sequence),
    at: Math.max(prior?.at ?? Number.NEGATIVE_INFINITY, event.at)
  })
}

export function journalPersonalStopAfter(
  frontier: JournalPersonalStopFrontier,
  after: { sequence?: number; at: number; turnId?: string }
): JournalPersonalStopEvidence {
  const stopped = [
    frontier.turns.get(undefined),
    ...(after.turnId ? [frontier.turns.get(after.turnId)] : [])
  ].some(
    (stop) =>
      stop && (after.sequence === undefined ? stop.at >= after.at : stop.sequence > after.sequence)
  )
  return stopped ? 'stopped' : frontier.complete ? 'clear' : 'unknown'
}
