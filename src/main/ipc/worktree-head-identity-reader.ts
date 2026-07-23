import { opendir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/types'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'

// Why: the whole point of this reader is replacing `git worktree list` fanout
// with bounded metadata-file reads, so head freshness never re-creates the
// spawn pressure that stalled terminal input. Keep it spawn-free.

const MAX_SYMREF_DEPTH = 5
export const MAX_GIT_HEAD_METADATA_BYTES = 64 * 1024
export const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024
export const MAX_PACKED_REFS_ENTRIES = 100_000
export const MAX_LINKED_WORKTREE_ENTRIES = 1_024
const MAX_PACKED_REFS_RETAINED_BYTES = 16 * 1024 * 1024
const MAX_IDENTITY_RETAINED_BYTES = 4 * 1024 * 1024

async function readTrimmedFile(
  path: string,
  maxBytes = MAX_GIT_HEAD_METADATA_BYTES
): Promise<string | null> {
  try {
    return (await readNodeFileWithinLimit(path, maxBytes)).buffer.toString('utf8').trim()
  } catch {
    return null
  }
}

// packed-refs lines are `<oid> <ref>`; `#` headers and `^` peel lines skipped.
async function readPackedRefs(commonDirPath: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>()
  const content = await readTrimmedFile(join(commonDirPath, 'packed-refs'), MAX_PACKED_REFS_BYTES)
  if (content === null) {
    return refs
  }
  let retainedBytes = 0
  for (let start = 0; start <= content.length; ) {
    const newline = content.indexOf('\n', start)
    const end = newline === -1 ? content.length : newline
    if (end - start > MAX_GIT_HEAD_METADATA_BYTES) {
      return new Map()
    }
    const line = content.slice(start, end)
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      // Headers and peeled-object lines never resolve a branch head.
    } else {
      const separator = line.indexOf(' ')
      if (separator > 0) {
        const ref = line.slice(separator + 1).trim()
        const oid = line.slice(0, separator)
        retainedBytes += (ref.length + oid.length) * 2
        if (
          refs.size >= MAX_PACKED_REFS_ENTRIES ||
          retainedBytes > MAX_PACKED_REFS_RETAINED_BYTES
        ) {
          return new Map()
        }
        refs.set(ref, oid)
      }
    }
    if (newline === -1) {
      break
    }
    start = newline + 1
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
  let retainedIdentityBytes = 0
  const retainIdentity = (identity: WorktreeHeadIdentity): boolean => {
    retainedIdentityBytes +=
      (identity.worktreePath.length + (identity.branch?.length ?? 0) + identity.head.length) * 2
    if (retainedIdentityBytes > MAX_IDENTITY_RETAINED_BYTES) {
      return false
    }
    identities.push(identity)
    return true
  }
  // Only the standard `<checkout>/.git` layout maps a common dir back to its
  // primary checkout path; bare/custom GIT_DIR layouts have no primary row.
  if (basename(commonDirPath) === '.git') {
    const primary = await readHeadIdentity(
      commonDirPath,
      join(commonDirPath, 'HEAD'),
      dirname(commonDirPath),
      packedRefs
    )
    if (primary && !retainIdentity(primary)) {
      return []
    }
  }

  let directory: Awaited<ReturnType<typeof opendir>>
  try {
    directory = await opendir(join(commonDirPath, 'worktrees'))
  } catch {
    return identities
  }
  let entriesSeen = 0
  try {
    for await (const entry of directory) {
      entriesSeen += 1
      if (entriesSeen > MAX_LINKED_WORKTREE_ENTRIES) {
        return []
      }
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
      if (identity && !retainIdentity(identity)) {
        return []
      }
    }
  } catch {
    return identities
  } finally {
    await directory.close().catch(() => undefined)
  }
  return identities
}
