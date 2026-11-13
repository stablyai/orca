import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../document-parts/profile-state-document-parts'
import { isRecord } from './profile-state-document-validation'

export type ProfileStateDomainPatchOperation =
  | { kind: 'set'; path: readonly string[]; payload: string }
  | { kind: 'remove'; path: readonly string[] }
  | { kind: 'order'; path: readonly string[]; keys: readonly string[] }

export type ProfileStateDomainPatch = {
  domain: string
  operations: readonly ProfileStateDomainPatchOperation[]
}

type PreparedOperation =
  | { kind: 'set'; path: readonly string[]; value: unknown }
  | Exclude<ProfileStateDomainPatchOperation, { kind: 'set' }>

export type PreparedProfileStateDomainPatch = {
  domain: string
  operations: readonly PreparedOperation[]
}

type PathNode = { mutation?: boolean; order?: boolean; children: Map<string, PathNode> }

export function prepareProfileStateDomainPatches(
  patches: readonly ProfileStateDomainPatch[]
): PreparedProfileStateDomainPatch[] {
  if (!Array.isArray(patches)) {
    throw new Error('Profile state patches must be an array')
  }
  const domains = new Set<string>()
  return patches.map((patch) => {
    const depth =
      isRecord(patch) && typeof patch.domain === 'string'
        ? PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(patch.domain)
        : undefined
    if (depth === undefined || domains.has(patch.domain) || !Array.isArray(patch.operations)) {
      throw new Error('Profile state patch domain is invalid or repeated')
    }
    domains.add(patch.domain)
    const root: PathNode = { children: new Map() }
    const operations = patch.operations.map((operation): PreparedOperation => {
      if (
        !isRecord(operation) ||
        !Array.isArray(operation.path) ||
        operation.path.length > depth ||
        !operation.path.every((key: unknown) => typeof key === 'string') ||
        (operation.kind !== 'set' && operation.kind !== 'remove' && operation.kind !== 'order')
      ) {
        throw new Error('Profile state patch operation is invalid')
      }
      let node = root
      for (const key of operation.path) {
        if (node.mutation || node.order) {
          throw new Error('Profile state patch operations conflict')
        }
        let child = node.children.get(key)
        if (!child) {
          child = { children: new Map() }
          node.children.set(key, child)
        }
        node = child
      }
      if (node.mutation || node.order) {
        throw new Error('Profile state patch operations repeat a path')
      }
      if (operation.kind === 'order') {
        if (
          operation.path.length >= depth ||
          !Array.isArray(operation.keys) ||
          !operation.keys.every((key: unknown) => typeof key === 'string') ||
          new Set(operation.keys).size !== operation.keys.length
        ) {
          throw new Error('Profile state patch order is invalid')
        }
        node.order = true
        return { kind: 'order', path: operation.path, keys: operation.keys }
      }
      if (node.children.size > 0 || (operation.kind === 'remove' && operation.path.length === 0)) {
        throw new Error('Profile state patch mutations conflict')
      }
      node.mutation = true
      if (operation.kind === 'remove') {
        return { kind: 'remove', path: operation.path }
      }
      if (typeof operation.payload !== 'string') {
        throw new Error('Profile state patch payload is invalid')
      }
      let value: unknown
      try {
        value = JSON.parse(operation.payload)
      } catch {
        throw new Error('Profile state patch payload is invalid JSON')
      }
      return { kind: 'set', path: operation.path, value }
    })
    return { domain: patch.domain, operations }
  })
}

export function defineProfileStateOwnValue(
  object: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

/** The worker owns this parsed base; no live Store references reach it. */
export function applyProfileStateDomainPatch(
  base: unknown,
  patch: PreparedProfileStateDomainPatch
): unknown {
  let value = base
  for (const operation of patch.operations) {
    let parent: unknown = value
    const parentPath = operation.path.slice(0, -1)
    for (const key of parentPath) {
      if (!isRecord(parent) || !Object.hasOwn(parent, key)) {
        throw new Error('Profile state patch parent is missing')
      }
      parent = parent[key]
    }
    const key = operation.path.at(-1)
    if (key !== undefined && !isRecord(parent)) {
      throw new Error('Profile state patch parent is not an object')
    }
    const replace = (next: unknown): void => {
      if (key === undefined) {
        value = next
      } else if (isRecord(parent)) {
        defineProfileStateOwnValue(parent, key, next)
      }
    }
    if (operation.kind === 'set') {
      replace(operation.value)
    } else if (operation.kind === 'remove') {
      if (!isRecord(parent) || key === undefined || !Object.hasOwn(parent, key)) {
        throw new Error('Profile state patch removal is missing')
      }
      delete parent[key]
    } else {
      const current = key === undefined ? value : isRecord(parent) ? parent[key] : undefined
      if (
        !isRecord(current) ||
        Object.keys(current).length !== operation.keys.length ||
        !operation.keys.every((entry) => Object.hasOwn(current, entry))
      ) {
        throw new Error('Profile state patch order does not cover its object')
      }
      const ordered: Record<string, unknown> = {}
      for (const entry of operation.keys) {
        defineProfileStateOwnValue(ordered, entry, current[entry])
      }
      if (Object.keys(ordered).some((entry, index) => entry !== operation.keys[index])) {
        throw new Error('Profile state patch order is not native JSON order')
      }
      replace(ordered)
    }
  }
  return value
}
