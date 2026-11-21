import { hashProfileStatePayload, isRecord } from '../documents/profile-state-document-validation'
import type { PreparedProfileStateDomainPatch } from '../documents/profile-state-domain-patches'
import type { ProfileStateDocumentPathPart } from './profile-state-document-parts'

/** One stored part: its canonical JSON text and that text's hash. */
export type PartsLeaf = { readonly payload: string; readonly hash: string }

/** An object above the split depth; children keep native JSON key order. */
export type PartsNode = { children: Record<string, PartsNode | PartsLeaf> }

const EMPTY_OBJECT = '{}'
const EMPTY_OBJECT_HASH = hashProfileStatePayload(EMPTY_OBJECT)

function isNode(entry: PartsNode | PartsLeaf): entry is PartsNode {
  return 'children' in entry
}

export function partsLeaf(payload: string, hash = hashProfileStatePayload(payload)): PartsLeaf {
  return { payload, hash }
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

/** The same leaves splitProfileStateDomainValue stores, built from a value parsed from JSON. */
function partsEntryFromValue(value: unknown, remaining: number): PartsNode | PartsLeaf {
  if (remaining > 0 && isRecord(value) && Object.keys(value).length > 0) {
    const node: PartsNode = { children: {} }
    for (const [key, child] of Object.entries(value)) {
      defineOwn(node.children, key, partsEntryFromValue(child, remaining - 1))
    }
    return node
  }
  return partsLeaf(JSON.stringify(value))
}

/** Rebuilds the tree from stored parts in document order; each part's hash was already checked. */
export function partsTreeFromStoredParts(
  parts: Iterable<{ path: readonly string[]; leaf: PartsLeaf }>
): PartsNode {
  const root: PartsNode = { children: {} }
  for (const { path, leaf } of parts) {
    if (path.length === 0) {
      // An empty domain is stored as one `{}` root part; anything else cannot take a patch.
      if (leaf.payload !== EMPTY_OBJECT) {
        throw new Error('Profile state patch base is not an object')
      }
      continue
    }
    let node = root
    for (const key of path.slice(0, -1)) {
      const next = Object.hasOwn(node.children, key) ? node.children[key] : undefined
      if (next === undefined) {
        const created: PartsNode = { children: {} }
        defineOwn(node.children, key, created)
        node = created
      } else if (isNode(next)) {
        node = next
      } else {
        throw new Error('Profile state parts overlap')
      }
    }
    defineOwn(node.children, path.at(-1)!, leaf)
  }
  return root
}

/** A container at `path`, turning a stored empty-object leaf back into one. */
function nodeAt(root: PartsNode, path: readonly string[]): PartsNode {
  let node = root
  for (const key of path) {
    if (!Object.hasOwn(node.children, key)) {
      throw new Error('Profile state patch parent is missing')
    }
    const next = node.children[key]!
    if (isNode(next)) {
      node = next
    } else if (next.payload === EMPTY_OBJECT) {
      const emptied: PartsNode = { children: {} }
      defineOwn(node.children, key, emptied)
      node = emptied
    } else {
      throw new Error('Profile state patch parent is not an object')
    }
  }
  return node
}

/**
 * Applies a patch to the tree in place, building only the touched entries; mirrors
 * applyProfileStateDomainPatch on the parsed value. Returns whether any stored part changed.
 */
export function applyPatchToPartsTree(
  root: PartsNode,
  patch: PreparedProfileStateDomainPatch,
  depth: number
): boolean {
  let changed = false
  for (const operation of patch.operations) {
    if (operation.kind === 'order') {
      const node = nodeAt(root, operation.path)
      const current = node.children
      if (
        Object.keys(current).length !== operation.keys.length ||
        !operation.keys.every((entry) => Object.hasOwn(current, entry))
      ) {
        throw new Error('Profile state patch order does not cover its object')
      }
      const ordered: Record<string, PartsNode | PartsLeaf> = {}
      for (const entry of operation.keys) {
        defineOwn(ordered, entry, current[entry])
      }
      if (Object.keys(ordered).some((entry, index) => entry !== operation.keys[index])) {
        throw new Error('Profile state patch order is not native JSON order')
      }
      changed ||= Object.keys(current).some((entry, index) => entry !== operation.keys[index])
      node.children = ordered
      continue
    }
    const parent = nodeAt(root, operation.path.slice(0, -1))
    const key = operation.path.at(-1)!
    if (operation.kind === 'remove') {
      if (!Object.hasOwn(parent.children, key)) {
        throw new Error('Profile state patch removal is missing')
      }
      delete parent.children[key]
      changed = true
      continue
    }
    const next = partsEntryFromValue(operation.value, depth - operation.path.length)
    const previous = Object.hasOwn(parent.children, key) ? parent.children[key] : undefined
    if (previous && !isNode(previous) && !isNode(next) && previous.payload === next.payload) {
      continue
    }
    defineOwn(parent.children, key, next)
    changed = true
  }
  return changed
}

/** A stored part with its row key, JSON.stringify(path). */
export type PartsTreePart = ProfileStateDocumentPathPart & { key: string; hash: string }

/** Depth-first stored parts, exactly as splitProfileStateDomainValue orders them. */
export function* partsTreeParts(root: PartsNode): Generator<PartsTreePart> {
  // Keys extend the parent's prefix, so no write re-serializes every part's path.
  function* visit(node: PartsNode, path: string[], prefix: string): Generator<PartsTreePart> {
    const keys = Object.keys(node.children)
    if (keys.length === 0) {
      yield { path, key: `${prefix}]`, payload: EMPTY_OBJECT, hash: EMPTY_OBJECT_HASH }
      return
    }
    for (const key of keys) {
      const child = node.children[key]!
      const childPath = [...path, key]
      const childPrefix = `${prefix}${path.length > 0 ? ',' : ''}${JSON.stringify(key)}`
      if (isNode(child)) {
        yield* visit(child, childPath, childPrefix)
      } else {
        yield { path: childPath, key: `${childPrefix}]`, payload: child.payload, hash: child.hash }
      }
    }
  }
  yield* visit(root, [], '[')
}
