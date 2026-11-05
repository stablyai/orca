import {
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation
} from './journal-sql-value-codec'

type TrackedValue = {
  location: JournalSqlValueLocation
  raw: object
  observers: Map<string, JournalSqlValueLocation>
}

export class JournalSqlValueObjects {
  readonly locations = new WeakMap<object, JournalSqlValueLocation>()
  private readonly wrapped = new WeakMap<object, object>()
  readonly tracked = new Map<string, TrackedValue>()
  readonly dirty = new Set<TrackedValue>()

  constructor(private readonly changed: (location: JournalSqlValueLocation) => void) {}

  untracked(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const location = this.locations.get(value)
    const node = location && this.tracked.get(journalSqlLocationKey(location))
    return node && location ? readJournalSqlReferencePath(node.raw, location.path) : value
  }

  track(value: unknown, location: JournalSqlValueLocation): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const node: TrackedValue = { location, raw: value, observers: new Map() }
    this.tracked.set(journalSqlLocationKey(location), node)
    return this.wrap(value, node, [])
  }

  observe(value: unknown, observer: JournalSqlValueLocation): void {
    if (typeof value !== 'object' || value === null) {
      return
    }
    const location = this.locations.get(value)
    const node = location && this.tracked.get(journalSqlLocationKey(location))
    node?.observers.set(JSON.stringify([observer.collection, observer.key]), observer)
  }

  private wrap(value: unknown, node: TrackedValue, path: string[]): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const source = this.locations.get(value)
    if (source && journalSqlLocationKey(source) !== journalSqlLocationKey(node.location)) {
      for (const observer of node.observers.values()) {
        this.observe(value, observer)
      }
      return this.wrapped.get(value) ?? value
    }
    const previous = this.wrapped.get(value)
    if (previous) {
      return previous
    }
    const changed = (): void => {
      this.dirty.add(node)
      for (const observer of node.observers.values()) {
        this.changed(observer)
      }
    }
    const proxy = new Proxy(value, {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy trap must preserve accessors and array methods with their receiver.
      get: (target, key, receiver) =>
        this.wrap(Reflect.get(target, key, receiver), node, [...path, String(key)]),
      set: (target, key, next) => {
        if (
          !Object.hasOwn(target, key) ||
          Object.getOwnPropertyDescriptor(target, key)?.value !== next
        ) {
          Reflect.set(target, key, next)
          changed()
        }
        return true
      },
      deleteProperty: (target, key) => {
        if (Object.hasOwn(target, key)) {
          Reflect.deleteProperty(target, key)
          changed()
        }
        return true
      },
      defineProperty: (target, key, descriptor) => {
        Reflect.defineProperty(target, key, descriptor)
        changed()
        return true
      }
    })
    const location = { ...node.location, path }
    this.locations.set(value, location)
    this.locations.set(proxy, location)
    this.wrapped.set(value, proxy)
    this.wrapped.set(proxy, proxy)
    return proxy
  }
}
