import { vi } from 'vitest'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function createRetainedMaterializerCounters(
  count: () => { fullInputs: number; fullViews: number; fullIterations: number },
  visit: (value: unknown) => void,
  inputMaps: WeakSet<object>
) {
  const readers: (() => void)[] = []
  const watched = new WeakSet<AgentSessionJournal>()
  const watchJournal = (journal: AgentSessionJournal) => {
    if (watched.has(journal)) {
      return
    }
    watched.add(journal)
    inputMaps.add(journal['state'].submissions)
    const submissions = journal.submissions
    const inputs = vi.spyOn(journal, 'submissions').mockImplementation(() => {
      count().fullInputs++
      return submissions()
    })
    const publicRead = journal.publicRead
    const seenViews = new WeakSet<object>()
    const read = vi.spyOn(journal, 'publicRead').mockImplementation(() => {
      const view = publicRead()
      if (!seenViews.has(view)) {
        seenViews.add(view)
        const getter = Object.getOwnPropertyDescriptor(view, 'snapshot')!.get!
        const full = vi.spyOn(view, 'snapshot', 'get').mockImplementation(() => {
          count().fullViews++
          return getter.call(view)
        })
        readers.push(() => full.mockRestore())
      }
      return view
    })
    readers.push(
      () => inputs.mockRestore(),
      () => read.mockRestore()
    )
  }
  const values = Map.prototype.values,
    keys = Map.prototype.keys,
    entries = Map.prototype.entries
  const mv = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
    this: Map<unknown, unknown>
  ) {
    if (inputMaps.has(this)) {
      count().fullIterations++
    }
    for (const value of values.call(this)) {
      visit(value)
      yield value
    }
    return undefined
  })
  const mk = vi.spyOn(Map.prototype, 'keys').mockImplementation(function* (
    this: Map<unknown, unknown>
  ) {
    if (inputMaps.has(this)) {
      count().fullIterations++
    }
    for (const key of keys.call(this)) {
      visit(key)
      yield key
    }
    return undefined
  })
  const me = vi.spyOn(Map.prototype, 'entries').mockImplementation(function* (
    this: Map<unknown, unknown>
  ) {
    if (inputMaps.has(this)) {
      count().fullIterations++
    }
    for (const entry of entries.call(this)) {
      visit(entry)
      yield entry
    }
    return undefined
  })
  const mi = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
    this: Map<unknown, unknown>
  ) {
    if (inputMaps.has(this)) {
      count().fullIterations++
    }
    for (const entry of entries.call(this)) {
      visit(entry)
      yield entry
    }
    return undefined
  })
  const mf = vi.spyOn(Map.prototype, 'forEach').mockImplementation(function (
    this: Map<unknown, unknown>,
    callback,
    receiver
  ) {
    if (inputMaps.has(this)) {
      count().fullIterations++
    }
    for (const [key, value] of entries.call(this)) {
      visit([key, value])
      callback.call(receiver, value, key, this)
    }
  })
  return {
    watchJournal,
    dispose: () => {
      for (const restore of readers.toReversed()) {
        restore()
      }
      for (const spy of [mv, mk, me, mi, mf]) {
        spy.mockRestore()
      }
    }
  }
}
