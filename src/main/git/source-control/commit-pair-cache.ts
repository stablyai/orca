import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveWorktreeHostPath } from '../../../shared/git/metadata/git-metadata-path'
import type { GitRuntimeOptions } from '../command-runner/git-runtime-options'
import { resolveGitCommonDir, resolveGitDir } from './resolve-git-dir'
import { canProveUnchangedByStamp, readFileStampComponent } from './worktree-diff-stamp'

/** Opaque object-store identity under which a commit pair's graph answers stay valid. */
export type CommitPairScope = string

/** One bounded LRU per answer kind keeps values typed without casts. */
export type CommitPairStore<T> = Map<string, T>

const MAX_ENTRIES_PER_STORE = 128
export const commitPairMergeBases: CommitPairStore<string> = new Map()
export const commitPairDivergences: CommitPairStore<{ ahead: number; behind: number }> = new Map()

// These move replace refs, grafts or the object store away from the common dir this scope stats.
const GRAPH_RELOCATING_ENV = [
  'GIT_REPLACE_REF_BASE',
  'GIT_GRAFT_FILE',
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_SHALLOW_FILE'
]
// Replace refs and grafts are rare and their effect depends on per-worktree config, so their presence disables caching.
const GRAPH_REWRITE_PATHS = [path.join('refs', 'replace'), path.join('info', 'grafts'), 'reftable']
// Bounds the one-off packed-refs scan per change; larger ref stores just skip caching.
const MAX_PACKED_REFS_SCAN_BYTES = 8 * 1024 * 1024
const MAX_SCANNED_PACKED_REFS = 64
/** Common dir -> packed-refs stamp last proven to hold no replace refs. */
const packedRefsWithoutReplaceRefs = new Map<string, string>()

/** Read without spawning Git; null when replace refs or grafts could apply, or inputs are not provably stable. */
export async function readCommitPairScope(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<CommitPairScope | null> {
  const capturedAtMs = Date.now()
  if (GRAPH_RELOCATING_ENV.some((name) => process.env[name])) {
    return null
  }
  try {
    const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
    if (!hostWorktreePath) {
      return null
    }
    const commonDir = await resolveGitCommonDir(await resolveGitDir(hostWorktreePath, options))
    const [objects, rewritePathsPresent, shallow, packedRefs] = await Promise.all([
      stat(path.join(commonDir, 'objects')),
      Promise.all(GRAPH_REWRITE_PATHS.map((input) => pathExists(path.join(commonDir, input)))),
      readFileStampComponent(path.join(commonDir, 'shallow')),
      readFileStampComponent(path.join(commonDir, 'packed-refs'))
    ])
    if (!objects.isDirectory() || rewritePathsPresent.some(Boolean)) {
      return null
    }
    const value = JSON.stringify([commonDir, shallow.text])
    const newestMtimeMs = Math.max(shallow.mtimeMs, packedRefs.mtimeMs)
    // A rewrite inside the mtime bucket could leave the stamp unchanged.
    if (!canProveUnchangedByStamp({ value, newestMtimeMs, capturedAtMs })) {
      return null
    }
    if (
      Number.isFinite(packedRefs.mtimeMs) &&
      !(await isPackedRefsFreeOfReplaceRefs(commonDir, packedRefs.text))
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

async function isPackedRefsFreeOfReplaceRefs(commonDir: string, stamp: string): Promise<boolean> {
  if (packedRefsWithoutReplaceRefs.get(commonDir) === stamp) {
    return true
  }
  const packedRefsPath = path.join(commonDir, 'packed-refs')
  if ((await stat(packedRefsPath)).size > MAX_PACKED_REFS_SCAN_BYTES) {
    return false
  }
  // Lines are `<oid> <refname>`; a false positive only skips caching.
  if ((await readFile(packedRefsPath, 'utf-8')).includes(' refs/replace/')) {
    return false
  }
  packedRefsWithoutReplaceRefs.delete(commonDir)
  packedRefsWithoutReplaceRefs.set(commonDir, stamp)
  if (packedRefsWithoutReplaceRefs.size > MAX_SCANNED_PACKED_REFS) {
    const oldest = packedRefsWithoutReplaceRefs.keys().next()
    if (!oldest.done) {
      packedRefsWithoutReplaceRefs.delete(oldest.value)
    }
  }
  return true
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false
    }
    throw error
  }
}

/** Reuse a successful answer for this exact commit pair; failures and aborts are never stored. */
export async function rememberCommitPair<T>(
  entries: CommitPairStore<T>,
  scope: CommitPairScope | null,
  rereadScope: () => Promise<CommitPairScope | null>,
  baseOid: string,
  headOid: string,
  compute: () => Promise<T>
): Promise<T> {
  if (scope === null) {
    return compute()
  }
  const key = JSON.stringify([scope, baseOid, headOid])
  const cached = entries.get(key)
  if (cached !== undefined) {
    entries.delete(key)
    entries.set(key, cached)
    return cached
  }
  const value = await compute()
  // A history rewrite during the walk would file its answer under the pre-rewrite scope.
  if ((await rereadScope()) !== scope) {
    return value
  }
  entries.set(key, value)
  if (entries.size > MAX_ENTRIES_PER_STORE) {
    const oldest = entries.keys().next()
    if (!oldest.done) {
      entries.delete(oldest.value)
    }
  }
  return value
}
