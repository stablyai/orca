import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/types'

// Why: the whole point of this reader is replacing `git worktree list` fanout
// with bounded metadata-file reads, so head freshness never re-creates the
// spawn pressure that stalled terminal input. Keep it spawn-free.

const MAX_SYMREF_DEPTH = 5

async function readTrimmedFile(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return null
  }
}

// packed-refs lines are `<oid> <ref>`; `#` headers and `^` peel lines skipped.
async function readPackedRefs(commonDirPath: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>()
  const content = await readTrimmedFile(join(commonDirPath, 'packed-refs'))
  if (content === null) {
    return refs
  }
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

// Why: ref content comes from repo files an attacker can craft. Git forbids
// `\` and `:` in ref names, and on Windows `join` also treats `\` as a
// separator — both must be rejected before splicing the ref into a file path.
function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  return !ref.split('/').some((part) => part === '..' || part === '')
}

// SHA-1 (40) or SHA-256 (64) object id. Anything else read from disk is not a
// head and must never be emitted — this also caps what any path escape could leak.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function asObjectId(value: string | null | undefined): string | null {
  return value != null && OBJECT_ID_PATTERN.test(value) ? value : null
}

async function resolveRefToOid(
  commonDirPath: string,
  ref: string,
  packedRefs: () => Promise<Map<string, string>>
): Promise<string | null> {
  let current = ref
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    if (!isSafeRefName(current)) {
      return null
    }
    // Branch refs are shared repo state, so loose files live in the common dir.
    const loose = await readTrimmedFile(join(commonDirPath, ...current.split('/')))
    if (loose === null) {
      return asObjectId((await packedRefs()).get(current))
    }
    if (loose.startsWith('ref: ')) {
      current = loose.slice('ref: '.length).trim()
      continue
    }
    return asObjectId(loose)
  }
  return null
}

async function readHeadIdentity(
  commonDirPath: string,
  headFilePath: string,
  worktreePath: string,
  packedRefs: () => Promise<Map<string, string>>
): Promise<WorktreeHeadIdentity | null> {
  const head = await readTrimmedFile(headFilePath)
  if (!head) {
    return null
  }
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length).trim()
    const oid = await resolveRefToOid(commonDirPath, ref, packedRefs)
    // Unborn branches (no commit yet) stay covered by the structural listing.
    if (!oid) {
      return null
    }
    return { worktreePath, head: oid, branch: ref }
  }
  const detachedOid = asObjectId(head)
  return detachedOid ? { worktreePath, head: detachedOid, branch: null } : null
}

/** Reads head/branch for the primary checkout and every linked worktree of a
 *  Git common dir using only metadata-file reads (HEAD, gitdir, loose refs,
 *  packed-refs) — no Git subprocess. Unresolvable entries are skipped so
 *  callers never overwrite store state with partial reads. */
export async function readGitCommonHeadIdentities(
  commonDirPath: string
): Promise<WorktreeHeadIdentity[]> {
  let packedRefsPromise: Promise<Map<string, string>> | null = null
  const packedRefs = (): Promise<Map<string, string>> =>
    (packedRefsPromise ??= readPackedRefs(commonDirPath))

  const identities: WorktreeHeadIdentity[] = []
  // Only the standard `<checkout>/.git` layout maps a common dir back to its
  // primary checkout path; bare/custom GIT_DIR layouts have no primary row.
  if (basename(commonDirPath) === '.git') {
    const primary = await readHeadIdentity(
      commonDirPath,
      join(commonDirPath, 'HEAD'),
      dirname(commonDirPath),
      packedRefs
    )
    if (primary) {
      identities.push(primary)
    }
  }

  let entries
  try {
    entries = await readdir(join(commonDirPath, 'worktrees'), { withFileTypes: true })
  } catch {
    return identities
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const entryPath = join(commonDirPath, 'worktrees', entry.name)
    const gitdirContent = await readTrimmedFile(join(entryPath, 'gitdir'))
    if (!gitdirContent) {
      continue
    }
    // `gitdir` holds `<worktree>/.git`, absolute or (with relative-path
    // worktrees) relative to the entry dir.
    const gitdirAbsolute = isAbsolute(gitdirContent)
      ? gitdirContent
      : join(entryPath, gitdirContent)
    const identity = await readHeadIdentity(
      commonDirPath,
      join(entryPath, 'HEAD'),
      dirname(gitdirAbsolute),
      packedRefs
    )
    if (identity) {
      identities.push(identity)
    }
  }
  return identities
}
