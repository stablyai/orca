import { vi } from 'vitest'
import { JournalInputLineageOwner } from './journal-input-lineage'
/** Instrument real index nodes without charging the test's discovery walk as production work. */
export function journalInputIndexProbe(
  keys: readonly string[],
  count: { allocated: () => void; read: () => void }
): ((node: unknown) => void) & { restore: () => void } {
  const seen = new WeakMap<object, Map<string, unknown>>()
  const originals: { node: object; key: string; descriptor?: PropertyDescriptor }[] = []
  const inspect = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) {
      return
    }
    const prior = seen.get(node)
    if (prior) {
      inspect(prior.get('left'))
      inspect(prior.get('right'))
      return
    }
    const values = new Map<string, unknown>()
    seen.set(node, values)
    count.allocated()
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      originals.push({ node, key, descriptor })
      values.set(key, descriptor?.value)
      if (key === 'left' || key === 'right') {
        inspect(values.get(key))
      }
      Object.defineProperty(node, key, {
        configurable: true,
        get: () => {
          count.read()
          return values.get(key)
        },
        set: (next) => {
          values.set(key, next)
        }
      })
    }
  }
  return Object.assign(inspect, {
    restore: () => {
      for (const { node, key, descriptor } of originals) {
        const value = seen.get(node)?.get(key)
        if (descriptor || value !== undefined) {
          Object.defineProperty(node, key, {
            ...descriptor,
            value,
            writable: true,
            configurable: true
          })
        } else {
          Reflect.deleteProperty(node, key)
        }
      }
      originals.length = 0
    }
  })
}

export function journalInputHistoryProbe() {
  let visits = 0
  const release = JournalInputLineageOwner.prototype.releaseHistory
  const spy = vi
    .spyOn(JournalInputLineageOwner.prototype, 'releaseHistory')
    .mockImplementation(function (this: JournalInputLineageOwner, keep) {
      release.call(this, (id) => {
        visits++
        return keep(id)
      })
    })
  return { spy, visits: () => visits }
}
