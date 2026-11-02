type Method = (...args: unknown[]) => unknown
type Tally = { visits: number; lookups: number }
// What every built-in iterator inherits, so a counted one keeps the iterator helpers.
const iteratorPrototype: object = Object.getPrototypeOf(Object.getPrototypeOf([].values()))
// Open measurements, innermost last; only the innermost counts, so a nested one is kept apart.
const open: Tally[] = []
let restore: (() => void) | null = null
// Work while the patches go on or off belongs to no measurement.
const visit = (count = 1) => {
  const tally = open.at(-1)
  if (tally) {
    tally.visits += count
  }
}

/** Every array, map and set element `run` visits while it runs synchronously, through iteration
 *  or a search, filter or callback method, and every map or set key it looks up. Work inside a
 *  nested call is that call's alone. Test-only: built-in prototypes are patched meanwhile. */
export function collectionVisits<T>(run: () => T): { value: T } & Tally {
  const tally = { visits: 0, lookups: 0 }
  restore ??= patchCollections()
  open.push(tally)
  try {
    return { value: run(), ...tally }
  } finally {
    open.pop()
    if (open.length === 0) {
      restore()
      restore = null
    }
  }
}

function patchCollections(): () => void {
  const originals: [Record<PropertyKey, Method>, PropertyKey, Method][] = []
  const replace = (target: object, key: PropertyKey, wrap: (original: Method) => Method) => {
    const proto = target as Record<PropertyKey, Method>
    originals.push([proto, key, proto[key]!])
    proto[key] = wrap(proto[key]!)
  }
  const counting = (original: Method) =>
    function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params -- a rest parameter would iterate and count itself
      const iterator = original.apply(this, arguments as never) as Iterator<unknown>
      return Object.assign(Object.create(iteratorPrototype), {
        next: () => {
          const step = iterator.next()
          visit(step.done ? 0 : 1)
          return step
        }
      })
    }
  for (const proto of [Array.prototype, Map.prototype, Set.prototype]) {
    for (const key of [Symbol.iterator, 'entries', 'values', 'keys']) {
      replace(proto, key, counting)
    }
  }
  const callbacks = ['filter', 'some', 'every', 'find', 'findIndex', 'map', 'flatMap', 'forEach']
  for (const [proto, keys] of [
    [Array.prototype, callbacks],
    [Map.prototype, ['forEach']],
    [Set.prototype, ['forEach']]
  ] as const) {
    for (const key of keys) {
      replace(
        proto,
        key,
        (original) =>
          // No spread or rest here: either would iterate an array and count itself.
          function (this: unknown, callback: unknown, thisArg: unknown) {
            return original.call(
              this,
              function (this: unknown) {
                visit()
                // eslint-disable-next-line prefer-rest-params -- see above
                return (callback as Method).apply(this, arguments as never)
              },
              thisArg
            )
          }
      )
    }
  }
  const indexOf = Array.prototype.indexOf
  for (const key of ['indexOf', 'includes']) {
    replace(
      Array.prototype,
      key,
      (original) =>
        function (this: unknown[], search: unknown, from: unknown) {
          const at = indexOf.call(this, search, from as number)
          visit(at === -1 ? this.length : at + 1)
          return original.call(this, search, from)
        }
    )
  }
  for (const proto of [Map.prototype, Set.prototype]) {
    for (const key of proto === Map.prototype ? ['get', 'has'] : ['has']) {
      replace(
        proto,
        key,
        (original) =>
          function (this: unknown, item: unknown) {
            const tally = open.at(-1)
            if (tally) {
              tally.lookups++
            }
            return original.call(this, item)
          }
      )
    }
  }
  return () => {
    for (const [proto, key, original] of originals.toReversed()) {
      proto[key] = original
    }
  }
}
