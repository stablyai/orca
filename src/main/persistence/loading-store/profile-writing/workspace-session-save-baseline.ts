import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../../profile-state/document-parts/profile-state-document-parts'
import type {
  ProfileStateDomainPatch,
  ProfileStateDomainPatchOperation
} from '../../profile-state/documents/profile-state-domain-patches'

/** One saved value; container keys are re-read on every save, so in-place key edits show up. */
type SavedNode = { value: unknown; keys?: string[]; children?: SavedNode[]; json?: string }

export type WorkspaceSessionSaveCandidate = {
  domain: string
  epoch: number
  node: SavedNode | undefined
}

// Anything JSON.stringify would not write as a plain key list is compared and saved whole.
function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    !('toJSON' in value && typeof value.toJSON === 'function')
  )
}

function snapshot(value: unknown, depth: number): SavedNode {
  if (depth === 0 || !isPlainContainer(value)) {
    return { value }
  }
  const keys: string[] = []
  const children: SavedNode[] = []
  for (const key of Object.keys(value)) {
    const child = value[key]
    // JSON.stringify drops these members.
    if (child !== undefined && typeof child !== 'function' && typeof child !== 'symbol') {
      keys.push(key)
      children.push(snapshot(child, depth - 1))
    }
  }
  return { value, keys, children }
}

// Tests record each captured entry's JSON so an in-place edit that skips clear() fails loudly.

function recordEntryJson(node: SavedNode): void {
  if (node.children) {
    node.children.forEach(recordEntryJson)
  } else {
    node.json = JSON.stringify(node.value)
  }
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function diff(
  current: SavedNode,
  previous: SavedNode,
  path: string[],
  operations: ProfileStateDomainPatchOperation[]
): void {
  if (!current.keys || !current.children || !previous.keys || !previous.children) {
    if (
      previous.json !== undefined &&
      Object.is(current.value, previous.value) &&
      JSON.stringify(current.value) !== previous.json
    ) {
      throw new Error(
        `Saved session entry ${JSON.stringify(path)} was edited in place; replace it or clear the save baseline`
      )
    }
    if (current.keys || previous.keys || !Object.is(current.value, previous.value)) {
      operations.push({ kind: 'set', path: [...path], payload: JSON.stringify(current.value) })
    }
    return
  }
  const { keys, children } = current
  if (sameKeys(keys, previous.keys)) {
    for (let index = 0; index < keys.length; index++) {
      path.push(keys[index]!)
      diff(children[index]!, previous.children[index]!, path, operations)
      path.pop()
    }
    return
  }
  const before = new Map(previous.keys.map((key, index) => [key, previous.children![index]!]))
  for (let index = 0; index < keys.length; index++) {
    path.push(keys[index]!)
    const prior = before.get(keys[index]!)
    if (prior) {
      diff(children[index]!, prior, path, operations)
    } else {
      operations.push({
        kind: 'set',
        path: [...path],
        payload: JSON.stringify(children[index]!.value)
      })
    }
    path.pop()
  }
  const present = new Set(keys)
  const kept = previous.keys.filter((key) => {
    if (!present.has(key)) {
      operations.push({ kind: 'remove', path: [...path, key] })
    }
    return present.has(key)
  })
  // The writer appends new keys, so any other order change must be sent explicitly.
  kept.push(...keys.filter((key) => !before.has(key)))
  if (!sameKeys(keys, kept)) {
    operations.push({ kind: 'order', path: [...path], keys })
  }
}

/**
 * The session domains as the writer last acknowledged them, kept on main so a save serializes only
 * the entries that changed since then. Cleared whenever the stored copy can't be assumed.
 */
export class WorkspaceSessionSaveBaseline {
  private epoch = 0
  private readonly acknowledged = new Map<string, SavedNode>()

  /** With 'patch', a patch when the writer holds an acknowledged copy; otherwise the caller saves it
   *  whole, and 'whole' only records the candidate. */
  capture(
    domain: string,
    value: unknown,
    mode: 'patch' | 'whole'
  ): { patch?: ProfileStateDomainPatch; candidate: WorkspaceSessionSaveCandidate } {
    const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(domain) ?? 0
    const node = isPlainContainer(value) ? snapshot(value, depth) : undefined
    if (node && process.env.VITEST) {
      recordEntryJson(node)
    }
    const candidate = { domain, epoch: this.epoch, node }
    const previous = this.acknowledged.get(domain)
    if (mode === 'whole' || !node || !previous?.keys) {
      return { candidate }
    }
    const operations: ProfileStateDomainPatchOperation[] = []
    diff(node, previous, [], operations)
    return { patch: { domain, operations }, candidate }
  }

  /** Call only after the writer committed every candidate's domain. */
  acknowledge(candidates: readonly WorkspaceSessionSaveCandidate[]): void {
    for (const { domain, epoch, node } of candidates) {
      if (epoch !== this.epoch) {
        continue
      }
      if (node) {
        this.acknowledged.set(domain, node)
      } else {
        this.acknowledged.delete(domain)
      }
    }
  }

  /** After a failed or complete write; an acknowledgement already in flight is dropped too. */
  clear(): void {
    this.acknowledged.clear()
    this.epoch += 1
  }
}
