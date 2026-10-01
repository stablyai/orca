import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { getErrorCode } from '../worktree-operation-options'

// The one set of rules for reading Git's admin files without spawning Git. The worktree
// membership model and the head-identity reader both go through these, so the two can never
// disagree on what a HEAD, a loose ref or `packed-refs` means.

// Git's SYMREF_MAXDEPTH. The HEAD read that named the first ref counts as one of them.
const MAX_SYMREF_DEPTH = 5

// Why: a watcher reports the admin dir name the OS gave it while readers use their own `readdir`
// name. Fold NFC/NFD and case so the two always agree — over-matching only costs one redundant
// read, under-matching loses an update.
export function adminEntryKey(name: string): string {
  return normalizeRuntimePathForComparison(name).toLowerCase()
}

// Why: a read that failed for any reason other than absence is an UNKNOWN, not an absence — the
// same distinction AGENTS.md draws for the SSH verdict vocabulary. Collapsing the two evicts
// state Orca still knows and turns a single EMFILE into a full re-read.
export const UNREADABLE = Symbol('unreadable')
export type Unreadable = typeof UNREADABLE

export async function readTrimmedAdminFile(path: string): Promise<string | null | Unreadable> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? null : UNREADABLE
  }
}

/** `<oid> <ref>` lines; `#` headers and `^` peel lines skipped. */
export function parsePackedRefs(content: string): Map<string, string> {
  const refs = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue
    }
    const separator = line.indexOf(' ')
    if (separator <= 0) {
      continue
    }
    refs.set(line.slice(separator + 1).trim(), line.slice(0, separator))
  }
  return refs
}

async function readPackedRefs(commonDirPath: string): Promise<Map<string, string> | Unreadable> {
  const content = await readTrimmedAdminFile(join(commonDirPath, 'packed-refs'))
  if (content === UNREADABLE) {
    return UNREADABLE
  }
  // No packed-refs file at all is a fact: every ref is loose.
  return content === null ? new Map() : parsePackedRefs(content)
}

// Why: ref content comes from repo files an attacker can craft. Git forbids `\` and `:` in ref
// names, and on Windows `join` also treats `\` as a separator — both must be rejected before
// splicing the ref into a file path.
export function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  return !ref.split('/').some((part) => part === '..' || part === '')
}

// SHA-1 (40) or SHA-256 (64) object id. Anything else read from disk is not a head and must never
// be emitted — this also caps what any path escape could leak.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export function asObjectId(value: string | null | undefined): string | null {
  return value != null && OBJECT_ID_PATTERN.test(value) ? value : null
}

export type RefFileContent = { symref: string } | { oid: string } | { garbage: true }

/** Git's loose-ref rule: `ref:` then optional whitespace names a symref; otherwise an object id,
 *  optionally followed by whitespace. Expects already-trimmed content. */
export function parseRefFileContent(content: string): RefFileContent {
  if (content.startsWith('ref:')) {
    return { symref: content.slice('ref:'.length).trim() }
  }
  const oid = asObjectId(content.split(/\s/, 1)[0])
  return oid ? { oid } : { garbage: true }
}

/** Which files a resolution depended on, so a caller can tell when its answer may have moved. */
export type RefResolutionTrace = {
  looseRefPaths: string[]
  usedPackedRefs: boolean
}

export type ResolvedRef =
  /** `ref` is the last name in the symref chain, which is the branch Git reports. */
  | { ref: string; oid: string | null }
  /** Not resolvable by these rules (bad name, garbage content, chain too deep). */
  | { ref: null; oid: null }

/** The oid `packed-refs` records for a ref, null when it records none. */
export type PackedRefLookup = (ref: string) => Promise<string | null | Unreadable>

/** Looks refs up in one parse of `packed-refs`, read on the first lookup. */
export function createPackedRefLookup(commonDirPath: string): PackedRefLookup {
  let packed: Promise<Map<string, string> | Unreadable> | null = null
  return async (ref) => {
    const refs = await (packed ??= readPackedRefs(commonDirPath))
    return refs === UNREADABLE ? UNREADABLE : (refs.get(ref) ?? null)
  }
}

/** Resolves the ref a HEAD names. */
export async function resolveRefToOid(
  commonDirPath: string,
  ref: string,
  packedRef: PackedRefLookup,
  trace?: RefResolutionTrace
): Promise<ResolvedRef | Unreadable> {
  let current = ref
  for (let depth = 1; depth < MAX_SYMREF_DEPTH; depth++) {
    if (!isSafeRefName(current)) {
      return { ref: null, oid: null }
    }
    // Branch refs are shared repo state, so loose files live in the common dir.
    const loosePath = join(commonDirPath, ...current.split('/'))
    trace?.looseRefPaths.push(loosePath)
    const loose = await readTrimmedAdminFile(loosePath)
    if (loose === UNREADABLE) {
      return UNREADABLE
    }
    if (loose === null) {
      if (trace) {
        trace.usedPackedRefs = true
      }
      const packed = await packedRef(current)
      return packed === UNREADABLE ? UNREADABLE : { ref: current, oid: asObjectId(packed) }
    }
    const parsed = parseRefFileContent(loose)
    if ('symref' in parsed) {
      current = parsed.symref
      continue
    }
    return 'oid' in parsed ? { ref: current, oid: parsed.oid } : { ref: null, oid: null }
  }
  return { ref: null, oid: null }
}
