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
  handoffVisits: 0,
  identityEntries: 0,
  sourceIdEntries: 0,
  overlayEntries: 0,
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

function countMap<T>(array: readonly T[], visit: () => void) {
  const map = array.map.bind(array)
  Object.defineProperty(array, 'map', {
    configurable: true,
    value: <U>(
      callback: (value: T, index: number, array: readonly T[]) => U,
      thisArg?: unknown
    ): U[] =>
      map((value, index, source) => {
        visit()
        return callback.call(thisArg, value, index, source)
      })
  })
}

function countFlatMap<T>(
  array: readonly T[],
  visit: () => void,
  result?: (values: readonly unknown[]) => void
) {
  const flatMap = array.flatMap.bind(array)
  Object.defineProperty(array, 'flatMap', {
    configurable: true,
    value: <U, This = undefined>(
      callback: (this: This, value: T, index: number, array: readonly T[]) => U | readonly U[],
      thisArg?: This
    ): U[] => {
      const values = flatMap<U, This>(function (value, index, source) {
        visit()
        return callback.call(this, value, index, source)
      }, thisArg)
      result?.(values)
      return values
    }
  })
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
  const restore = legacy.readJournalLegacyCards
  vi.spyOn(legacy, 'readJournalLegacyCards').mockImplementation((...args) => {
    const measured = counts[phase]
    const before = measured.decodedRows
    const cards = restore(...args)
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
  const overlay = index.overlay
  vi.spyOn(index, 'overlay').mockImplementation(function (
    this: JournalInputCardIndex,
    state,
    rows
  ) {
    watchIndexMap(this['overlays'])
    if (!overlays.has(rows)) {
      overlays.add(rows)
      countMap(rows, () => {
        if (overlaying) {
          counts[phase].overlayEntries++
        }
      })
      countIteration(rows, () => {
        if (overlaying) {
          counts[phase].overlayVisits++
        }
      })
    }
    overlaying = true
    try {
      return overlay.call(this, state, rows)
    } finally {
      overlaying = false
    }
  })
  const update = index.indexCard
  vi.spyOn(index, 'indexCard').mockImplementation(function (
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
    return update.call(this, state, card)
  })
  const ensure = index.ensure
  vi.spyOn(index, 'ensure').mockImplementation(function (
    this: JournalInputCardIndex,
    state,
    floor
  ) {
    watchIndexMap(this['overlays'])
    watchIndexMap(state.queue.cards)
    const before = this['index']
    ensuring = true
    try {
      ensure.call(this, state, floor)
    } finally {
      ensuring = false
    }
    if (this['index'] !== before) {
      counts[phase].indexRebuilds++
    }
  })
  const Original = legacy.LegacyQueuedCards
  vi.spyOn(legacy, 'LegacyQueuedCards').mockImplementation(
    class extends Original {
      constructor(private readonly source: ConstructorParameters<typeof Original>[0]) {
        super(source)
        const read = this['read'].bind(this)
        this['read'] = () => {
          const rows = read()
          countMap(rows, () => counts[phase].sourceIdEntries++)
          countFlatMap(
            rows,
            () => counts[phase].ownerClassifications++,
            (cards) => {
              if (classifying) {
                countFlatMap(cards, () => {
                  if (classifying) {
                    counts[phase].handoffVisits++
                  }
                })
                countMap(cards, () => {
                  if (classifying) {
                    counts[phase].identityEntries++
                  }
                })
              }
            }
          )
          return rows
        }
      }

      override cards() {
        classifying = true
        try {
          const cards = super.cards()
          const handedOff = this['viewed']?.handedOff
          if (handedOff && !handoffs.has(handedOff)) {
            handoffs.add(handedOff)
            countIteration(handedOff, () => counts[phase].handoffApplications++)
          }
          return cards
        } finally {
          classifying = false
        }
      }

      override displayState() {
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
    reset: () => {
      for (const value of Object.values(counts)) {
        Object.assign(value, emptyLegacyCounts())
      }
    }
  }
}
