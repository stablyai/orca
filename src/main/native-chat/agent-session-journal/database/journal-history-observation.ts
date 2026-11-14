import type { JournalHostDatabase } from './journal-host-database'
import type { JournalOutcomeSource } from '../outcomes/journal-outcome-format'
import {
  historySourceState,
  historyCoverage,
  historySourceKey,
  historyCovers,
  ensureHistoryCoverage,
  type Source,
  type Coverage
} from './journal-history-source'

/** Lexical read authority only; awaits, writes and closing validation require another observation. */
export type JournalHistoryObservation = {
  readonly epoch: string | null
  readonly outcome: JournalOutcomeSource | null
  readonly rawThrough: number
  readonly sources: readonly { readonly source: Source; readonly coverage: Coverage | undefined }[]
  readonly identity: string | null
}

export function observeJournalHistory(
  database: JournalHostDatabase,
  sessionId: string,
  initialize = false
): JournalHistoryObservation {
  const state = historySourceState(database.db, sessionId)
  const sources = state.sources.map((source) => {
    let coverage: Coverage | undefined
    try {
      coverage = historyCoverage(database.db, source)
    } catch {
      // Strict source reads remain usable when optional locator metadata is unavailable.
    }
    return { source, coverage }
  })
  if (initialize && sources.some(({ coverage }) => !coverage || coverage.dirty !== 0)) {
    for (const { source, coverage } of sources) {
      if (!coverage || coverage.dirty !== 0) {
        ensureHistoryCoverage(database, source)
      }
    }
    return observeJournalHistory(database, sessionId)
  }
  const identity = sources.every(({ coverage }) => coverage?.dirty === 0)
    ? JSON.stringify(
        sources.map(({ source, coverage }) => [historySourceKey(source), coverage!.incarnation])
      )
    : null
  return {
    epoch: state.epoch,
    outcome: state.outcome,
    rawThrough: state.rawThrough,
    sources,
    identity
  }
}

export function observedHistorySource(
  observation: JournalHistoryObservation,
  epoch: string,
  generation: number
) {
  return observation.sources.find(
    ({ source }) => source.epoch === epoch && source.generation === generation
  )
}

export function observedHistoryCovered(
  observation: JournalHistoryObservation,
  epoch: string,
  generation: number,
  through: number
): boolean {
  const saved = observedHistorySource(observation, epoch, generation)
  return Boolean(
    saved?.coverage?.dirty === 0 && historyCovers(saved.source, saved.coverage, through)
  )
}

export function observedHistoryIncarnation(
  observation: JournalHistoryObservation,
  epoch: string,
  generation: number
): string | null {
  const saved = observedHistorySource(observation, epoch, generation)
  return saved?.coverage?.dirty === 0 ? saved.coverage.incarnation : null
}

export async function prepareJournalStopHistory(
  database: JournalHostDatabase,
  sessionId: string,
  demand: (source: Source) => Promise<boolean>
): Promise<'ready' | 'unknown' | 'unavailable'> {
  let observed: JournalHistoryObservation
  try {
    observed = observeJournalHistory(database, sessionId)
  } catch {
    return 'unknown'
  }
  try {
    if (observed.sources.some(({ coverage }) => !coverage || coverage.dirty !== 0)) {
      observed = observeJournalHistory(database, sessionId, true)
    }
    if (observed.identity === null) {
      return 'unavailable'
    }
    const expected = observed.identity
    const demands = observed.sources
      .filter(({ source }) => source.generation === 0)
      .map(({ source, coverage }) =>
        coverage?.dirty === 0 && historyCovers(source, coverage, source.through)
          ? Promise.resolve(true)
          : demand(source)
      )
    const ready = await Promise.all(demands)
    const current = observeJournalHistory(database, sessionId)
    return ready.every(Boolean) &&
      expected === current.identity &&
      current.sources.every(
        ({ source }) =>
          source.generation !== 0 ||
          observedHistoryCovered(current, source.epoch, 0, source.through)
      )
      ? 'ready'
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export async function prepareJournalHistory(
  database: JournalHostDatabase,
  sessionId: string,
  include: (source: Source) => boolean,
  demand: (source: Source) => Promise<boolean>
): Promise<boolean> {
  try {
    const observed = observeJournalHistory(database, sessionId, true)
    if (observed.identity === null) {
      return false
    }
    const expected = observed.identity
    const sources = observed.sources.filter(({ source }) => include(source))
    const ready = await Promise.all(
      sources.map(({ source, coverage }) =>
        coverage?.dirty === 0 && historyCovers(source, coverage, source.through)
          ? Promise.resolve(true)
          : demand(source)
      )
    )
    const current = observeJournalHistory(database, sessionId)
    return (
      ready.every(Boolean) &&
      expected === current.identity &&
      current.sources.every(
        ({ source }) =>
          !include(source) ||
          observedHistoryCovered(current, source.epoch, source.generation, source.through)
      )
    )
  } catch {
    return false
  }
}
