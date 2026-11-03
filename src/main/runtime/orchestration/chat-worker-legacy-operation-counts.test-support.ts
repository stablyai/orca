import { vi } from 'vitest'
import * as legacy from '../../native-chat/agent-session-journal/journal-queue-import'
import * as fold from '../../native-chat/agent-session-journal/journal-queue-fold'
import * as stored from '../../native-chat/agent-session-journal/queued-message-stored-row'
import { JournalInputCardIndex } from '../../native-chat/agent-session-journal/journal-input-card-index'

export const emptyLegacyCounts = () => ({
  decodedRows: 0,
  restoredRows: 0,
  ownerClassifications: 0,
  cardConstructions: 0,
  sourceVisits: 0,
  overlayVisits: 0,
  priorOverlayVisits: 0,
  rebuildVisits: 0,
  indexUpdates: 0,
  overlayIndexUpdates: 0,
  rebuildIndexUpdates: 0,
  pointIndexUpdates: 0,
  indexRebuilds: 0,
  displays: 0,
  handoffApplications: 0,
  itemCopies: 0,
  itemEntries: 0,
  submissionCopies: 0,
  submissionEntries: 0
})

function countMapCopies<K, V>(map: Map<K, V>, copy: () => void, visit: () => void) {
  const iterate = map[Symbol.iterator].bind(map)
  return vi.spyOn(map, Symbol.iterator).mockImplementation(() => {
    copy()
    const iterator = iterate()
    const next = iterator.next.bind(iterator)
    vi.spyOn(iterator, 'next').mockImplementation(() => {
      const result = next()
      if (!result.done) {
        visit()
      }
      return result
    })
    return iterator
  })
}

function countIteration<T>(array: readonly T[], visit: () => void) {
  const iterate = array[Symbol.iterator].bind(array)
  Object.defineProperty(array, Symbol.iterator, {
    configurable: true,
    value: function* () {
      for (const value of { [Symbol.iterator]: iterate }) {
        visit()
        yield value
      }
    }
  })
}

function countValues<K, V>(map: Map<K, V>, visit: () => void) {
  const values = map.values.bind(map)
  Object.defineProperty(map, 'values', {
    configurable: true,
    value: function* () {
      for (const value of { [Symbol.iterator]: values }) {
        visit()
        yield value
      }
    }
  })
}

function observeAdvances<T>(steps: Generator<void, T>, enter: () => () => void) {
  const next = steps.next.bind(steps)
  steps.next = (...args) => {
    const leave = enter()
    try {
      return next(...args)
    } finally {
      leave()
    }
  }
  return steps
}

/** Count delegated passes at their real boundaries, including upstream before publication. */
export function countLegacyFailureDisplay() {
  const counts = {
    upstream: emptyLegacyCounts(),
    publication: emptyLegacyCounts(),
    failure: emptyLegacyCounts()
  }
  let phase: keyof typeof counts = 'upstream'
  let classifying = false
  let overlaying = false
  let ensuring = false
  const overlays = new WeakSet<readonly unknown[]>()
  const handoffs = new WeakSet<readonly unknown[]>()
  const decode = stored.readStoredQueuedMessageRow
  vi.spyOn(stored, 'readStoredQueuedMessageRow').mockImplementation((row) => {
    counts[phase].decodedRows++
    return decode(row)
  })
  const restore = legacy.readJournalLegacyCardsAsync
  vi.spyOn(legacy, 'readJournalLegacyCardsAsync').mockImplementation(async (...args) => {
    const measured = counts[phase]
    const before = measured.decodedRows
    const cards = await restore(...args)
    measured.restoredRows += measured.decodedRows - before
    return cards
  })
  const construct = fold.queuedCardFromChange
  vi.spyOn(fold, 'queuedCardFromChange').mockImplementation((...args) => {
    counts[phase].cardConstructions++
    return construct(...args)
  })
  const indexMaps = new WeakSet<object>()
  const watchIndexMap = <K, V>(map: Map<K, V>) => {
    if (!indexMaps.has(map)) {
      indexMaps.add(map)
      countValues(map, () => {
        if (ensuring) {
          counts[phase].rebuildVisits++
        } else if (overlaying) {
          counts[phase].priorOverlayVisits++
        }
      })
    }
  }
  const index = JournalInputCardIndex.prototype
  const overlay = index.overlaySteps
  vi.spyOn(index, 'overlaySteps').mockImplementation(function* (
    this: JournalInputCardIndex,
    state,
    rows
  ) {
    watchIndexMap(this['overlays'])
    if (!overlays.has(rows)) {
      overlays.add(rows)
      countIteration(rows, () => {
        if (overlaying) {
          counts[phase].overlayVisits++
        }
      })
    }
    return yield* observeAdvances(overlay.call(this, state, rows), () => {
      const previous = overlaying
      overlaying = true
      return () => {
        overlaying = previous
      }
    })
  })
  const update = index.indexCardSteps
  vi.spyOn(index, 'indexCardSteps').mockImplementation(function* (
    this: JournalInputCardIndex,
    state,
    card
  ) {
    counts[phase].indexUpdates++
    if (ensuring) {
      counts[phase].rebuildIndexUpdates++
    } else if (overlaying) {
      counts[phase].overlayIndexUpdates++
    } else {
      counts[phase].pointIndexUpdates++
    }
    return yield* update.call(this, state, card)
  })
  const ensure = index.ensureSteps
  vi.spyOn(index, 'ensureSteps').mockImplementation(function* (
    this: JournalInputCardIndex,
    state,
    floor
  ) {
    watchIndexMap(this['overlays'])
    watchIndexMap(state.queue.cards)
    const before = this['index']
    yield* observeAdvances(ensure.call(this, state, floor), () => {
      const previous = ensuring
      ensuring = true
      return () => {
        ensuring = previous
      }
    })
    if (this['index'] !== before) {
      counts[phase].indexRebuilds++
    }
  })
  const instrumentedSources = new WeakSet<object>()
  const Original = legacy.LegacyQueuedCards
  vi.spyOn(legacy, 'LegacyQueuedCards').mockImplementation(
    class extends Original {
      constructor(private readonly source: ConstructorParameters<typeof Original>[0]) {
        super(source)
        const read = this['rows'].bind(this)
        this['rows'] = () => {
          const rows = read()
          if (instrumentedSources.has(rows)) {
            return rows
          }
          instrumentedSources.add(rows)
          countIteration(rows, () => {
            if (classifying) {
              counts[phase].ownerClassifications++
            }
            counts[phase].sourceVisits++
          })
          return rows
        }
        const steps = this['cardSteps'].bind(this)
        this['cardSteps'] = function* () {
          return yield* observeAdvances(steps(), () => {
            const previous = classifying
            classifying = true
            return () => {
              classifying = previous
            }
          })
        }
      }

      override displayState() {
        this.cards()
        const handedOff = this['viewed']?.handedOff
        if (handedOff && !handoffs.has(handedOff)) {
          handoffs.add(handedOff)
          countIteration(handedOff, () => counts[phase].handoffApplications++)
        }
        const previous = phase
        if (phase !== 'publication') {
          phase = 'failure'
        }
        const measured = counts[phase]
        measured.displays++
        const state = this.source.state()
        const items = countMapCopies(
          state.items,
          () => measured.itemCopies++,
          () => measured.itemEntries++
        )
        const submissions = countMapCopies(
          state.submissions,
          () => measured.submissionCopies++,
          () => measured.submissionEntries++
        )
        try {
          return super.displayState()
        } finally {
          items.mockRestore()
          submissions.mockRestore()
          phase = previous
        }
      }
    }
  )
  return {
    counts,
    publication: <T>(publish: () => T): T => {
      const previous = phase
      phase = 'publication'
      try {
        return publish()
      } finally {
        phase = previous
      }
    },
    reset: () => Object.values(counts).forEach((value) => Object.assign(value, emptyLegacyCounts()))
  }
}
