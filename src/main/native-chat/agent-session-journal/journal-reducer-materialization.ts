import type { JournalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'

export type JournalReplacementGraph = { state: JournalReducerState; order: JournalInputOrder }

/** Detached materialization uses the draft resolver's identities, never its source-mutating finish. */
export function* materializeJournalReplacementSteps(
  graph: JournalReplacementGraph,
  read: <Value extends object>(value: Value) => { identity: object; source: object }
): Generator<void, JournalReplacementGraph> {
  const copies = new WeakMap<object, object>()
  function* materialize(value: unknown): Generator<void, unknown> {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const { identity, source } = read(value)
    const prior = copies.get(identity)
    if (prior) {
      return prior
    }
    const copy =
      source instanceof Map
        ? new Map()
        : source instanceof Set
          ? new Set()
          : Array.isArray(source)
            ? []
            : Object.create(Object.getPrototypeOf(source))
    copies.set(identity, copy)
    if (source instanceof Map) {
      for (const [key, entry] of source) {
        copy.set(yield* materialize(key), yield* materialize(entry))
        yield
      }
    } else if (source instanceof Set) {
      for (const entry of source) {
        copy.add(yield* materialize(entry))
        yield
      }
    } else if (Array.isArray(source)) {
      for (const entry of source) {
        copy.push(yield* materialize(entry))
        yield
      }
    } else {
      for (const key of Reflect.ownKeys(source)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!
        if ('value' in descriptor) {
          descriptor.value = yield* materialize(descriptor.value)
        }
        Reflect.defineProperty(copy, key, descriptor)
        yield
      }
    }
    return copy
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver preserves the complete journal graph's prototypes, aliases and cycles.
  return (yield* materialize(graph)) as JournalReplacementGraph
}
