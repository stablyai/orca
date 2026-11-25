// The page targets es2022 syntax (Chromium 94), but the code and its libraries call newer built-ins:
// gesture-handler's web detector uses Set.union/intersection/difference (Chromium 122), react-navigation
// uses Array.toSpliced (110), a URL check and mermaid's sanitizer call URL.canParse (120). Vendor WebViews that never update (Huawei/Honor ship Chromium 99) lack them.
// Each one is installed only where missing, so current WebViews and iOS keep their native versions.

type Grouped<K, T> = Map<K, T[]>

function groupInto<K, T>(items: Iterable<T>, keyOf: (item: T, index: number) => K): Grouped<K, T> {
  const groups: Grouped<K, T> = new Map()
  let index = 0
  for (const item of items) {
    const key = keyOf(item, index++)
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return groups
}

function relativeIndex(length: number, index: number): number {
  const integer = Math.trunc(Number(index)) || 0
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length)
}

// Array.from, not slice: the built-ins fill holes with undefined instead of keeping them.
export const arrayPolyfills = {
  toSorted<T>(this: T[], compare?: (a: T, b: T) => number): T[] {
    return Array.from(this).sort(compare)
  },
  toReversed<T>(this: T[]): T[] {
    const copy: T[] = []
    for (let index = this.length - 1; index >= 0; index--) {
      copy.push(this[index])
    }
    return copy
  },
  toSpliced<T>(this: T[], start?: number, deleteCount?: number, ...items: T[]): T[] {
    const copy: T[] = Array.from(this)
    if (arguments.length === 0) {
      return copy
    }
    const from = relativeIndex(copy.length, start ?? 0)
    const count =
      arguments.length === 1
        ? copy.length - from
        : Math.min(Math.max(Math.trunc(Number(deleteCount)) || 0, 0), copy.length - from)
    copy.splice(from, count, ...items)
    return copy
  },
  with<T>(this: T[], index: number, value: T): T[] {
    const copy: T[] = Array.from(this)
    const integer = Math.trunc(Number(index)) || 0
    const at = integer < 0 ? copy.length + integer : integer
    if (at < 0 || at >= copy.length) {
      throw new RangeError('Invalid index')
    }
    copy[at] = value
    return copy
  }
}

// Set methods accept any set-like (size, has, keys); the page only passes Sets.
type SetLike<T> = { size: number; has(value: T): boolean; keys(): Iterator<T> }

function keysOf<T>(other: SetLike<T>): T[] {
  const keys: T[] = []
  const iterator = other.keys()
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    keys.push(step.value)
  }
  return keys
}

export const setPolyfills = {
  union<T>(this: Set<T>, other: SetLike<T>): Set<T> {
    const result = new Set(this)
    for (const value of keysOf(other)) {
      result.add(value)
    }
    return result
  },
  intersection<T>(this: Set<T>, other: SetLike<T>): Set<T> {
    // Like the built-in, walk the smaller side, so the result keeps that side's order.
    const result = new Set<T>()
    const values = this.size <= other.size ? [...this] : keysOf(other)
    const lookup = this.size <= other.size ? other : this
    for (const value of values) {
      if (lookup.has(value)) {
        result.add(value)
      }
    }
    return result
  },
  difference<T>(this: Set<T>, other: SetLike<T>): Set<T> {
    const result = new Set<T>()
    for (const value of this) {
      if (!other.has(value)) {
        result.add(value)
      }
    }
    return result
  },
  symmetricDifference<T>(this: Set<T>, other: SetLike<T>): Set<T> {
    const result = new Set(this)
    for (const value of keysOf(other)) {
      if (this.has(value)) {
        result.delete(value)
      } else {
        result.add(value)
      }
    }
    return result
  },
  isSubsetOf<T>(this: Set<T>, other: SetLike<T>): boolean {
    for (const value of this) {
      if (!other.has(value)) {
        return false
      }
    }
    return true
  },
  isSupersetOf<T>(this: Set<T>, other: SetLike<T>): boolean {
    return keysOf(other).every((value) => this.has(value))
  },
  isDisjointFrom<T>(this: Set<T>, other: SetLike<T>): boolean {
    for (const value of this) {
      if (other.has(value)) {
        return false
      }
    }
    return true
  }
}

export function mapGroupBy<K, T>(
  items: Iterable<T>,
  keyOf: (item: T, index: number) => K
): Grouped<K, T> {
  return groupInto(items, keyOf)
}

export function objectGroupBy<T>(
  items: Iterable<T>,
  keyOf: (item: T, index: number) => PropertyKey
): Partial<Record<PropertyKey, T[]>> {
  const result: Partial<Record<PropertyKey, T[]>> = Object.create(null)
  // Property keys are strings or symbols, so 1 and "1" share a group, as in the built-in.
  const propertyKeyOf = (item: T, index: number) => {
    const key = keyOf(item, index)
    return typeof key === 'symbol' ? key : String(key)
  }
  for (const [key, group] of groupInto(items, propertyKeyOf)) {
    result[key] = group
  }
  return result
}

export function promiseWithResolvers<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export function urlCanParse(url: string | URL, base?: string | URL): boolean {
  try {
    new URL(url, base)
    return true
  } catch {
    return false
  }
}

type BuiltInOwner =
  | unknown[]
  | Set<unknown>
  | MapConstructor
  | ObjectConstructor
  | PromiseConstructor
  | typeof URL

function defineMissing(target: BuiltInOwner, methods: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(methods)) {
    if (name in target) {
      continue
    }
    // Built-in methods are writable, configurable and not enumerable; match them so for-in stays clean.
    Object.defineProperty(target, name, { value, writable: true, configurable: true })
  }
}

export function installOlderWebViewPolyfills(): void {
  defineMissing(Array.prototype, arrayPolyfills)
  defineMissing(Set.prototype, setPolyfills)
  defineMissing(Map, { groupBy: mapGroupBy })
  defineMissing(Object, { groupBy: objectGroupBy })
  defineMissing(Promise, { withResolvers: promiseWithResolvers })
  defineMissing(URL, { canParse: urlCanParse })
}
