import { journalInputOrder, setJournalInputOrder } from './journal-input-order'
// Track writes through objects, iterators and collection entries; finalize only after COMMIT.

import type { JournalReducerState } from './journal-reducer'
import {
  JournalDraftMap,
  JournalDraftSet,
  type JournalDraftAccess,
  type JournalEntryChange
} from './journal-transition-collections'

type DraftNode = {
  original: object
  value: object
  /** What the draft holds now: the copy once written, else the object itself. */
  current: () => object
  finish: () => object
  listen: (changed: () => void) => void
}

function draftProperty<Value extends object>(value: Value, key: PropertyKey): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
  return descriptor && ('value' in descriptor ? descriptor.value : descriptor.get?.call(value))
}

class JournalDraft {
  private readonly originals = new WeakMap<object, DraftNode>()
  private readonly proxies = new WeakMap<object, DraftNode>()
  private readonly collections: (JournalDraftMap<unknown, unknown> | JournalDraftSet<unknown>)[] =
    []
  private readonly derived: object[] = []
  private readonly assigned = new WeakSet<object>()
  private readonly pending: (() => void)[] = []
  private readonly resolved = new WeakMap<object, object>()
  /** Objects and collections the fold reached; scaling tests pin how this grows with chat size. */
  nodes = 0
  derivedNodes = 0
  private notifications: Set<() => void> | undefined

  readonly access: JournalDraftAccess = {
    wrap: (value, changed, path) => this.wrap(value, changed, path),
    assign: (value) => {
      if (typeof value === 'object' && value !== null) {
        this.assigned.add(value)
      }
    },
    finish: (value) => this.resolve(value),
    defer: (apply) => this.pending.push(apply)
  }

  wrap<T>(value: T, changed: () => void, path: string): T {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const node = this.proxies.get(value) ?? this.originals.get(value) ?? this.track(value, path)
    if (!path.startsWith('@inputOrder')) {
      node.listen(changed)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a node's draft (overlay collection or copy-on-write proxy) has the interface of the object it isolates.
    return node.value as T
  }

  private track<T extends object>(value: T, path: string): DraftNode {
    this.nodes += 1
    if (path.startsWith('@inputOrder')) {
      this.derivedNodes++
    }
    const listeners = new Set<() => void>()
    let dirty = false
    const mark = (): void => {
      dirty = true
      const outer = this.notifications === undefined
      const wave = (this.notifications ??= new Set())
      // Rotated/shared index nodes can reach the same ancestor by several paths.
      if (wave.has(mark)) {
        return
      }
      wave.add(mark)
      try {
        for (const notify of listeners) {
          notify()
        }
      } finally {
        if (outer) {
          this.notifications = undefined
        }
      }
    }
    const listen = (notify: () => void): void => {
      listeners.add(notify)
      if (dirty) {
        notify()
      }
    }
    let node: DraftNode
    if (value instanceof Map || value instanceof Set) {
      const collection =
        value instanceof Map
          ? new JournalDraftMap(value, this.access, mark, path)
          : new JournalDraftSet(value, this.access, mark, path)
      this.collections.push(collection)
      node = {
        original: value,
        value: collection,
        current: () => collection,
        finish: () => collection.finish(),
        listen
      }
    } else {
      let copy: object | undefined
      const current = (): object => copy ?? value
      const writable = (): object => {
        const next =
          copy ??
          (Array.isArray(value)
            ? [...value]
            : Object.assign(Object.create(Object.getPrototypeOf(value)), value))
        copy = next
        return next
      }
      const assignedKeys = new Set<PropertyKey>()
      const target = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
      const proxy = new Proxy(target, {
        get: (_target, key, receiver) =>
          this.wrap(
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
            Reflect.get(current(), key, receiver),
            mark,
            path ? `${path}.${String(key)}` : String(key)
          ),
        has: (_target, key) => Reflect.has(current(), key),
        ownKeys: () => Reflect.ownKeys(current()),
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(current(), key)
          return (
            descriptor && { ...descriptor, configurable: key !== 'length' || !Array.isArray(value) }
          )
        },
        set: (_target, key, next) => {
          const before = Reflect.getOwnPropertyDescriptor(current(), key)
          if (!before || !Object.is(before.value, next)) {
            this.access.assign(next)
            assignedKeys.add(key)
            Reflect.set(writable(), key, next)
            mark()
          }
          return true
        },
        deleteProperty: (_target, key) => {
          if (Object.hasOwn(current(), key)) {
            Reflect.deleteProperty(writable(), key)
            mark()
          }
          return true
        },
        defineProperty: (_target, key, descriptor) => {
          this.access.assign(descriptor.value)
          assignedKeys.add(key)
          Reflect.defineProperty(writable(), key, descriptor)
          mark()
          return true
        }
      })
      node = {
        original: value,
        value: proxy,
        current,
        finish: () => {
          if (!dirty && !this.assigned.has(value)) {
            return value
          }
          const result = writable()
          const keys = Reflect.ownKeys(result)
          for (const key of keys) {
            const child: unknown = draftProperty(result, key)
            if (assignedKeys.has(key) || this.assigned.has(value) || this.tracks(child)) {
              Reflect.set(result, key, this.finish(child))
            }
          }
          // Holders of reducer objects across commits keep reading the live object, so apply the
          // committed copy to it, keeping the key order in-place mutation would have left.
          const previous = Reflect.ownKeys(value)
          const reordered =
            !Array.isArray(value) && previous.some((key, index) => key !== keys[index])
          for (const key of previous) {
            if (reordered || !Object.hasOwn(result, key)) {
              Reflect.deleteProperty(value, key)
            }
          }
          for (const key of keys) {
            Reflect.set(value, key, draftProperty(result, key))
          }
          return value
        },
        listen
      }
    }
    if (path.startsWith('@inputOrder')) {
      this.derived.push(node.value)
    }
    this.originals.set(value, node)
    this.proxies.set(node.value, node)
    return node
  }

  changes(reset = false): JournalEntryChange[] {
    return this.collections.flatMap((collection) => collection.changes(reset))
  }

  /** Reads a draft value as it stands without tracking it, so serializing a changed value reaches
   * no proxy trap and adds no node. */
  untracked(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    return (this.proxies.get(value) ?? this.originals.get(value))?.current() ?? value
  }

  adopt<T>(value: T): T {
    const result = this.resolve(value)
    // Derived nodes adopt their own point changes; rotated ancestors do not own those writes.
    for (const node of this.derived) {
      this.resolve(node)
    }
    for (const apply of this.pending) {
      apply()
    }
    return result
  }

  private resolve<T>(value: T): T {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: finishing returns the value itself or the live object its draft stands for, so its type is unchanged.
    return this.finish(value) as T
  }

  private tracks(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      (this.originals.has(value) || this.proxies.has(value))
    )
  }

  private finish(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) {
      return value
    }
    const previous = this.resolved.get(value)
    if (previous) {
      return previous
    }
    const node = this.proxies.get(value) ?? this.originals.get(value)
    if (node) {
      // The derived owner points back to canonical state and shares index entries.
      // Resolve that identity before children so a committed graph is finalized once.
      this.resolved.set(value, node.original)
      this.resolved.set(node.value, node.original)
      const result = node.finish()
      this.resolved.set(value, result)
      this.resolved.set(node.value, result)
      return result
    }
    this.resolved.set(value, value)
    if (value instanceof Map || value instanceof Set) {
      return value
    }
    // Values created during the fold may hold drafts introduced by spread or destructuring.
    for (const key of Reflect.ownKeys(value)) {
      const child: unknown = draftProperty(value, key)
      const finished = this.finish(child)
      if (finished !== child) {
        Reflect.set(value, key, finished)
      }
    }
    return value
  }
}

/** Fold onto a draft of `state`; the live state changes only when `adopt` runs after COMMIT. */
export function isolateJournalTransition<T>(
  state: JournalReducerState,
  fold: (draft: JournalReducerState) => T
): {
  state: JournalReducerState
  result: T
  changes: (reset?: boolean) => JournalEntryChange[]
  /** A `JSON.stringify` replacer giving each draft value as it stands, untracked. */
  untracked: (key: string, value: unknown) => unknown
  adopt: () => JournalReducerState
  tracked: () => number
  trackedDerived: () => number
} {
  const draft = new JournalDraft()
  const candidate = draft.wrap(state, () => undefined, '')
  // Register canonical maps before the facade can reach them through an isolated query.
  void candidate.inputEntries
  void candidate.inputCards
  const order = draft.wrap(journalInputOrder(state), () => undefined, '@inputOrder')
  setJournalInputOrder(candidate, order)
  const result = fold(candidate)
  return {
    state: candidate,
    result,
    changes: (reset) =>
      draft.changes(reset).filter((entry) => !entry.path.startsWith('@inputOrder')),
    untracked: (_key, value) => draft.untracked(value),
    adopt: () => {
      const adopted = draft.adopt({ state: candidate, order })
      setJournalInputOrder(adopted.state, adopted.order)
      return adopted.state
    },
    trackedDerived: () => draft.derivedNodes,
    tracked: () => draft.nodes
  }
}
