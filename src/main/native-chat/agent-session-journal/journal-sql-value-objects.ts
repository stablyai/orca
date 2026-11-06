import {
  journalSqlLocationKey,
  readJournalSqlReferencePath,
  type JournalSqlValueLocation
} from './journal-sql-value-codec'

type TrackedValue = {
  location: JournalSqlValueLocation
  raw: object
  observers: Map<string, JournalSqlValueLocation>
  modified: boolean
}

export class JournalSqlValueObjects {
  readonly locations = new WeakMap<object, JournalSqlValueLocation>()
  private readonly wrapped = new WeakMap<object, object>()
  private readonly originals = new WeakMap<object, object>()
  private readonly owners = new WeakMap<object, { node: TrackedValue; path: string[] }>()
  readonly tracked = new Map<string, TrackedValue>()
  readonly dirty = new Set<TrackedValue>()

  constructor(private readonly changed: (location: JournalSqlValueLocation) => void) {}

  untracked(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const location = this.locations.get(value)
    const node = location && this.tracked.get(journalSqlLocationKey(location))
    return node && location
      ? readJournalSqlReferencePath(node.raw, location.path)
      : (this.originals.get(value) ?? value)
  }

  input<T>(value: T): T {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input wrappers preserve all properties; they acquire a storage home only if the reducer retains them.
    return this.wrap(value, undefined, []) as T
  }

  track(value: unknown, location: JournalSqlValueLocation): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const node: TrackedValue = {
      location,
      raw: this.originals.get(value) ?? value,
      observers: new Map(),
      modified: false
    }
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
    // Draft listeners replay earlier mutations when a later row reaches the same object.
    if (node?.modified) {
      this.changed(observer)
    }
  }

  private wrap(value: unknown, node: TrackedValue | undefined, path: string[]): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const source = this.locations.get(value)
    if (
      source &&
      (!node || journalSqlLocationKey(source) !== journalSqlLocationKey(node.location))
    ) {
      for (const observer of node?.observers.values() ?? []) {
        this.observe(value, observer)
      }
      return this.wrapped.get(value) ?? value
    }
    const previous = this.wrapped.get(value)
    if (previous) {
      if (node && !source) {
        this.own(value, previous, node, path)
      }
      return previous
    }
    const changed = (): void => {
      const owner = this.owners.get(proxy)
      if (!owner) {
        return
      }
      this.dirty.add(owner.node)
      owner.node.modified = true
      for (const observer of owner.node.observers.values()) {
        this.changed(observer)
      }
    }
    const proxy = new Proxy(value, {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy trap must preserve accessors and array methods with their receiver.
      get: (target, key, receiver) => {
        const owner = this.owners.get(proxy)
        return this.wrap(Reflect.get(target, key, receiver), owner?.node, [
          ...(owner?.path ?? []),
          String(key)
        ])
      },
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
    if (node) {
      this.own(value, proxy, node, path)
    }
    this.originals.set(proxy, value)
    this.wrapped.set(value, proxy)
    this.wrapped.set(proxy, proxy)
    return proxy
  }

  private own(value: object, proxy: object, node: TrackedValue, path: string[]): void {
    const location = { ...node.location, path }
    this.locations.set(value, location)
    this.locations.set(proxy, location)
    this.owners.set(proxy, { node, path })
  }
}
