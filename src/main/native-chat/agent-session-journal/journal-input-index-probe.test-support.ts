/** Instrument real index nodes without charging the test's discovery walk as production work. */
export function journalInputIndexProbe(
  keys: readonly string[],
  count: { allocated: () => void; read: () => void }
): (node: unknown) => void {
  const seen = new WeakMap<object, Map<string, unknown>>()
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
      values.set(key, Object.getOwnPropertyDescriptor(node, key)?.value)
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
  return inspect
}
