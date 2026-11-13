import { types } from 'node:util'
import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../../profile-state/document-parts/profile-state-document-parts'
import {
  defineProfileStateOwnValue,
  type ProfileStateDomainPatch,
  type ProfileStateDomainPatchOperation
} from '../../profile-state/documents/profile-state-domain-patches'

const unsupported = Symbol('native domain serialization required')

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function admitObject(value: unknown): asserts value is Record<string, unknown> | unknown[] {
  if (types.isProxy(value) || (!record(value) && !Array.isArray(value))) {
    throw unsupported
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw unsupported
  }
  admitToJson(value)
  if ('isRawJSON' in JSON && typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(value)) {
    throw unsupported
  }
}

function admitToJson(value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'toJSON')
  if (descriptor && (!('value' in descriptor) || typeof descriptor.value === 'function')) {
    throw unsupported
  }
}

function admitPrototypes(): void {
  if (
    Object.getPrototypeOf(Object.prototype) !== null ||
    Object.getPrototypeOf(Array.prototype) !== Object.prototype
  ) {
    throw unsupported
  }
  admitToJson(Object.prototype)
  admitToJson(Array.prototype)
}

function readDataProperty(value: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) {
    throw unsupported
  }
  return descriptor.value
}

function enter(
  value: unknown,
  ancestors: Set<object>
): asserts value is Record<string, unknown> | unknown[] {
  admitObject(value)
  if (ancestors.has(value)) {
    throw unsupported
  }
  ancestors.add(value)
}

/** Complete admission even after a mismatch; native stringify must never discover a hidden hook. */
function equalJson(value: unknown, previous: unknown, ancestors: Set<object>): boolean {
  if (value === null || value === undefined) {
    return previous === null
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value === previous
    case 'number':
      return (Number.isFinite(value) ? value : null) === previous
    case 'object':
      break
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw unsupported
  }
  enter(value, ancestors)
  try {
    if (Array.isArray(value)) {
      const old = Array.isArray(previous) ? previous : []
      let equal = Array.isArray(previous) && old.length === value.length
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw unsupported
        }
        const childEqual = equalJson(
          readDataProperty(value, String(index)),
          Object.hasOwn(old, index) ? old[index] : undefined,
          ancestors
        )
        equal &&= childEqual
      }
      return equal
    }
    const old = record(previous) ? previous : undefined
    const oldKeys = old ? Object.keys(old) : []
    let equal = old !== undefined
    let index = 0
    for (const key of Object.keys(value)) {
      const child = readDataProperty(value, key)
      if (child === undefined) {
        continue
      }
      const childEqual = equalJson(
        child,
        old && Object.hasOwn(old, key) ? old[key] : undefined,
        ancestors
      )
      equal &&= key === oldKeys[index] && childEqual
      index++
    }
    return equal && index === oldKeys.length
  } finally {
    ancestors.delete(value)
  }
}

export type CapturedProfileStateSplitDomain = {
  patch: ProfileStateDomainPatch
  value: unknown
}

/** Only admitted storage or a successful commit may replace these independent JSON trees. */
export class ProfileStateSplitSnapshots {
  private readonly acknowledged = new Map<string, unknown>()

  seed(state: Record<string, unknown> | undefined): void {
    this.acknowledged.clear()
    for (const domain of PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.keys()) {
      this.acknowledged.set(domain, structuredClone(state?.[domain]))
    }
  }

  clear(): void {
    this.acknowledged.clear()
  }

  acknowledge(candidates: ReadonlyMap<string, unknown>): void {
    for (const [domain, value] of candidates) {
      this.acknowledged.set(domain, value)
    }
  }

  capture(domain: string, value: unknown): CapturedProfileStateSplitDomain | undefined {
    const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(domain)
    if (depth === undefined || !this.acknowledged.has(domain) || value === undefined) {
      return undefined
    }
    const operations: ProfileStateDomainPatchOperation[] = []
    const path: string[] = []
    const ancestors = new Set<object>()
    const set = (current: unknown): unknown => {
      const payload = JSON.stringify(current)
      if (payload === undefined) {
        throw unsupported
      }
      operations.push({ kind: 'set', path: [...path], payload })
      return JSON.parse(payload)
    }
    const visit = (current: unknown, previous: unknown, remaining: number): unknown => {
      if (remaining === 0 || !record(current) || !record(previous)) {
        return equalJson(current, previous, ancestors) ? previous : set(current)
      }
      enter(current, ancestors)
      try {
        const oldKeys = Object.keys(previous)
        const keys: string[] = []
        let next = previous
        const change = (): Record<string, unknown> => {
          if (next === previous) {
            next = { ...previous }
          }
          return next
        }
        for (const key of Object.keys(current)) {
          const child = readDataProperty(current, key)
          if (child === undefined) {
            continue
          }
          keys.push(key)
          path.push(key)
          const captured = visit(
            child,
            Object.hasOwn(previous, key) ? previous[key] : undefined,
            remaining - 1
          )
          path.pop()
          if (!Object.hasOwn(previous, key) || captured !== previous[key]) {
            defineProfileStateOwnValue(change(), key, captured)
          }
        }
        const present = new Set(keys)
        for (const key of oldKeys) {
          if (!present.has(key)) {
            operations.push({ kind: 'remove', path: [...path, key] })
            delete change()[key]
          }
        }
        const naturalKeys = next === previous ? oldKeys : Object.keys(next)
        if (naturalKeys.some((key, index) => key !== keys[index])) {
          const ordered: Record<string, unknown> = {}
          for (const key of keys) {
            defineProfileStateOwnValue(ordered, key, next[key])
          }
          operations.push({ kind: 'order', path: [...path], keys })
          next = ordered
        }
        return next
      } finally {
        ancestors.delete(current)
      }
    }
    try {
      // Eligible capture invokes no user code, so prototype admission holds for this traversal only.
      admitPrototypes()
      const candidate = visit(value, this.acknowledged.get(domain), depth)
      return { patch: { domain, operations }, value: candidate }
    } catch (error) {
      if (error !== unsupported) {
        throw error
      }
      return undefined
    }
  }
}
