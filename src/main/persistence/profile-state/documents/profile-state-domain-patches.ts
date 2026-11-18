import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../document-parts/profile-state-document-parts'
import { isRecord } from './profile-state-document-validation'

/** Paths are object keys from the domain root, no deeper than the domain's split depth. */
export type ProfileStateDomainPatchOperation =
  | { kind: 'set'; path: readonly string[]; payload: string }
  | { kind: 'remove'; path: readonly string[] }
  | { kind: 'order'; path: readonly string[]; keys: readonly string[] }

/** Changes to a split domain since the writer's last acknowledged copy, applied in order. */
export type ProfileStateDomainPatch = {
  domain: string
  operations: readonly ProfileStateDomainPatchOperation[]
}

type PreparedOperation =
  | { kind: 'set'; path: readonly string[]; value: unknown }
  | { kind: 'remove'; path: readonly string[] }
  | { kind: 'order'; path: readonly string[]; keys: readonly string[] }

export type PreparedProfileStateDomainPatch = {
  domain: string
  operations: readonly PreparedOperation[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function prepareOperation(operation: unknown, depth: number): PreparedOperation {
  if (!isRecord(operation) || !isStringArray(operation.path) || operation.path.length > depth) {
    throw new Error('Profile state patch operation is invalid')
  }
  const { path } = operation
  if (operation.kind === 'order') {
    if (
      path.length >= depth ||
      !isStringArray(operation.keys) ||
      new Set(operation.keys).size !== operation.keys.length
    ) {
      throw new Error('Profile state patch order is invalid')
    }
    return { kind: 'order', path, keys: operation.keys }
  }
  if (path.length === 0) {
    throw new Error('Profile state patch cannot replace its domain root')
  }
  if (operation.kind === 'remove') {
    return { kind: 'remove', path }
  }
  if (operation.kind !== 'set' || typeof operation.payload !== 'string') {
    throw new Error('Profile state patch operation is invalid')
  }
  try {
    return { kind: 'set', path, value: JSON.parse(operation.payload) }
  } catch {
    throw new Error('Profile state patch payload is invalid JSON')
  }
}

/** Validates and parses patches before the write transaction opens. */
export function prepareProfileStateDomainPatches(
  patches: unknown
): PreparedProfileStateDomainPatch[] {
  if (!Array.isArray(patches)) {
    throw new Error('Profile state patches must be an array')
  }
  const domains = new Set<string>()
  return patches.map((patch: unknown) => {
    const domain: unknown = isRecord(patch) ? patch.domain : undefined
    const depth =
      typeof domain === 'string' ? PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(domain) : undefined
    if (
      typeof domain !== 'string' ||
      depth === undefined ||
      domains.has(domain) ||
      !isRecord(patch) ||
      !Array.isArray(patch.operations)
    ) {
      throw new Error('Profile state patch domain is invalid or repeated')
    }
    domains.add(domain)
    return {
      domain,
      operations: patch.operations.map((operation: unknown) => prepareOperation(operation, depth))
    }
  })
}

// Plain assignment of "__proto__" would replace the prototype instead of adding the key.
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

function containerAt(root: unknown, path: readonly string[]): Record<string, unknown> {
  let current = root
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      throw new Error('Profile state patch parent is missing')
    }
    current = current[key]
  }
  if (!isRecord(current)) {
    throw new Error('Profile state patch parent is not an object')
  }
  return current
}

/** Applies a patch to a value the writer parsed itself; any mismatch with the stored copy throws. */
export function applyProfileStateDomainPatch(
  base: unknown,
  patch: PreparedProfileStateDomainPatch
): unknown {
  if (!isRecord(base)) {
    throw new Error('Profile state patch base is not an object')
  }
  for (const operation of patch.operations) {
    if (operation.kind === 'order') {
      const parentPath = operation.path.slice(0, -1)
      const key = operation.path.at(-1)
      const current = containerAt(base, operation.path)
      if (
        Object.keys(current).length !== operation.keys.length ||
        !operation.keys.every((entry) => Object.hasOwn(current, entry))
      ) {
        throw new Error('Profile state patch order does not cover its object')
      }
      const ordered: Record<string, unknown> = {}
      for (const entry of operation.keys) {
        defineOwn(ordered, entry, current[entry])
      }
      if (Object.keys(ordered).some((entry, index) => entry !== operation.keys[index])) {
        throw new Error('Profile state patch order is not native JSON order')
      }
      if (key === undefined) {
        for (const entry of operation.keys) {
          delete base[entry]
          defineOwn(base, entry, ordered[entry])
        }
      } else {
        defineOwn(containerAt(base, parentPath), key, ordered)
      }
      continue
    }
    const parent = containerAt(base, operation.path.slice(0, -1))
    const key = operation.path.at(-1)!
    if (operation.kind === 'set') {
      defineOwn(parent, key, operation.value)
    } else if (Object.hasOwn(parent, key)) {
      delete parent[key]
    } else {
      throw new Error('Profile state patch removal is missing')
    }
  }
  return base
}
