import { vi } from 'vitest'
import * as legacy from '../../native-chat/agent-session-journal/journal-queue-import'

const emptyCounts = () => ({
  displays: 0,
  cardVisits: 0,
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

/** Delegates the real legacy display, counting its cached array and source Map iterators only. */
export function countLegacyFailureDisplay() {
  const counts = { publication: emptyCounts(), failure: emptyCounts() }
  let phase: keyof typeof counts = 'failure'
  let displaying = false
  const arrays = new WeakSet<readonly unknown[]>()
  const Original = legacy.LegacyQueuedCards
  vi.spyOn(legacy, 'LegacyQueuedCards').mockImplementation(
    class extends Original {
      constructor(private readonly source: ConstructorParameters<typeof Original>[0]) {
        super(source)
      }

      override cards() {
        const cards = super.cards()
        if (!arrays.has(cards)) {
          arrays.add(cards)
          cards.forEach((card, index) => {
            Object.defineProperty(cards, index, {
              get: () => {
                if (displaying) {
                  counts[phase].cardVisits++
                }
                return card
              }
            })
          })
        }
        return cards
      }

      override displayState() {
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
        displaying = true
        try {
          return super.displayState()
        } finally {
          displaying = false
          items.mockRestore()
          submissions.mockRestore()
        }
      }
    }
  )
  return {
    counts,
    publication: <T>(publish: () => T): T => {
      phase = 'publication'
      try {
        return publish()
      } finally {
        phase = 'failure'
      }
    },
    reset: () => {
      Object.assign(counts.publication, emptyCounts())
      Object.assign(counts.failure, emptyCounts())
    }
  }
}
