import {
  serializeProfileStateDomainFragment,
  extractProfileStateDomainPayload
} from './profile-state-authority-writes'
import { types } from 'node:util'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'
import {
  appendProfileStateOwnValue,
  type ProfileStateDomainPatch,
  type ProfileStateDomainPatchOperation
} from '../../profile-state/documents/profile-state-domain-patches'

const unsupported = Symbol('native session serialization required')
const depths = new Map<string, number>([
  [WORKSPACE_SESSION_DOMAINS[0], 1],
  [WORKSPACE_SESSION_DOMAINS[1], 2]
])
type FieldVector = Map<string, unknown>
type Candidate = { domain: string; epoch: number; fields: FieldVector }

function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw unsupported
  }
  return descriptor.value
}

function admitToJson(value: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'toJSON')
  if (
    descriptor &&
    (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')
  ) {
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

function admitObject(value: unknown): asserts value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
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

function admitJson(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return
  }
  admitObject(value)
  if (ancestors.has(value)) {
    throw unsupported
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        admitJson(ownValue(value, String(index)), ancestors)
      }
    } else {
      for (const key of Object.keys(value)) {
        admitJson(ownValue(value, key), ancestors)
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

function vector(value: unknown, depth: number): FieldVector {
  admitObject(value)
  if (Array.isArray(value)) {
    throw unsupported
  }
  const fields: FieldVector = new Map()
  for (const key of Object.keys(value)) {
    const child = ownValue(value, key)
    if (child !== undefined) {
      fields.set(key, depth === 1 ? child : vector(child, depth - 1))
    }
  }
  return fields
}

function changes(
  current: FieldVector,
  previous: FieldVector,
  depth: number,
  path: string[],
  operations: ProfileStateDomainPatchOperation[]
): void {
  for (const [key, value] of current) {
    appendProfileStateOwnValue(path, key)
    if (depth > 1 && previous.has(key)) {
      // SAFETY: vectors contain Maps at every ancestor level and live values only at field depth.
      changes(value as FieldVector, previous.get(key) as FieldVector, depth - 1, path, operations)
    } else if (!previous.has(key) || !Object.is(value, previous.get(key))) {
      const fragment = serializeProfileStateDomainFragment(
        key,
        depth === 1 ? value : vectorValue(value as FieldVector, depth - 1)
      )
      if (fragment === '{}') {
        throw unsupported
      }
      const payload = extractProfileStateDomainPayload(key, fragment)
      appendProfileStateOwnValue(operations, { kind: 'set', path: [...path], payload })
    }
    path.pop()
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) {
      appendProfileStateOwnValue(operations, { kind: 'remove', path: [...path, key] })
    }
  }
  const natural = [...previous.keys()].filter((key) => current.has(key))
  for (const key of current.keys()) {
    if (!previous.has(key)) {
      appendProfileStateOwnValue(natural, key)
    }
  }
  const keys = [...current.keys()]
  if (keys.some((key, index) => key !== natural[index])) {
    appendProfileStateOwnValue(operations, { kind: 'order', path: [...path], keys })
  }
}

function vectorValue(fields: FieldVector, depth: number): Record<string, unknown> {
  const value: Record<string, unknown> = {}
  for (const [key, child] of fields) {
    Object.defineProperty(value, key, {
      value: depth === 1 ? child : vectorValue(child as FieldVector, depth - 1),
      enumerable: true
    })
  }
  return value
}

/** Ownership belongs to the Store; an ACK may update fields but can never grant ownership. */
export class WorkspaceSessionFieldCapture {
  private readonly epochs = new Map<string, number>()
  private readonly owned = new Set<string>()
  private readonly acknowledged = new Map<string, FieldVector>()

  initialize(owned = true): void {
    this.clear()
    if (!owned) {
      return
    }
    for (const domain of depths.keys()) {
      this.owned.add(domain)
    }
  }

  clear(): void {
    for (const domain of depths.keys()) {
      this.expose(domain)
    }
  }

  expose(domain: string): void {
    this.owned.delete(domain)
    this.acknowledged.delete(domain)
    this.epochs.set(domain, (this.epochs.get(domain) ?? 0) + 1)
  }

  isOwned(domain: string): boolean {
    return this.owned.has(domain)
  }

  /** Only new detached input is walked; unchanged owned fields are never traversed. */
  admit(domain: string, input: unknown): void {
    if (!this.isOwned(domain)) {
      return
    }
    try {
      admitPrototypes()
      admitJson(input, new Set())
    } catch (error) {
      if (error !== unsupported) {
        throw error
      }
      this.expose(domain)
    }
  }

  snapshot(domain: string, value: unknown): Candidate | undefined {
    const depth = depths.get(domain)
    if (!this.isOwned(domain) || depth === undefined || value === undefined) {
      return undefined
    }
    try {
      admitPrototypes()
      return { domain, epoch: this.epochs.get(domain) ?? 0, fields: vector(value, depth) }
    } catch (error) {
      if (error !== unsupported) {
        throw error
      }
      this.expose(domain)
      return undefined
    }
  }

  acknowledge(candidates: readonly Candidate[]): void {
    for (const candidate of candidates) {
      if (this.isOwned(candidate.domain) && this.epochs.get(candidate.domain) === candidate.epoch) {
        this.acknowledged.set(candidate.domain, candidate.fields)
      }
    }
  }

  capture(
    domain: string,
    value: unknown
  ): { patch: ProfileStateDomainPatch; candidate: Candidate } | undefined {
    const previous = this.acknowledged.get(domain)
    const candidate = this.snapshot(domain, value)
    if (!previous || !candidate) {
      return undefined
    }
    const operations: ProfileStateDomainPatchOperation[] = []
    changes(candidate.fields, previous, depths.get(domain)!, [], operations)
    return { patch: { domain, operations }, candidate }
  }
}
