import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveWorktreeHostPath } from '../../../shared/git/metadata/git-metadata-path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveGitCommonDir, resolveGitDir } from './resolve-git-dir'
import { canProveUnchangedByStamp, readFileStampComponent } from './worktree-diff-stamp'

/** Opaque object-store identity under which a commit pair's graph answers stay valid. */
export type CommitPairScope = string

type CommitPairKind = 'merge-base' | 'divergence'

const MAX_ENTRIES = 256
const entries = new Map<string, unknown>()

// Shallow boundaries, grafts and replace refs rewrite parents of unchanged OIDs; packed/reftable refs can hold replace refs.
const HISTORY_REWRITE_INPUTS = [
  'shallow',
  path.join('info', 'grafts'),
  path.join('refs', 'replace'),
  'packed-refs',
  path.join('reftable', 'tables.list')
]

/** Read without spawning Git; null when the object store or its history inputs cannot be proven stable. */
export async function readCommitPairScope(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<CommitPairScope | null> {
  const capturedAtMs = Date.now()
  try {
    const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
    if (!hostWorktreePath) {
      return null
    }
    const commonDir = await resolveGitCommonDir(await resolveGitDir(hostWorktreePath, options))
    const [objects, ...components] = await Promise.all([
      stat(path.join(commonDir, 'objects')),
      ...HISTORY_REWRITE_INPUTS.map((input) => readFileStampComponent(path.join(commonDir, input)))
    ])
    if (!objects.isDirectory()) {
      return null
    }
    const value = JSON.stringify([commonDir, ...components.map((component) => component.text)])
    const newestMtimeMs = Math.max(...components.map((component) => component.mtimeMs))
    // A rewrite inside the mtime bucket could leave the stamp unchanged.
    return canProveUnchangedByStamp({ value, newestMtimeMs, capturedAtMs }) ? value : null
  } catch {
    return null
  }
}

/** Reuse a successful answer for this exact commit pair; failures and aborts are never stored. */
export async function rememberCommitPair<T>(
  scope: CommitPairScope | null,
  rereadScope: () => Promise<CommitPairScope | null>,
  kind: CommitPairKind,
  baseOid: string,
  headOid: string,
  compute: () => Promise<T>
): Promise<T> {
  if (scope === null) {
    return compute()
  }
  const key = JSON.stringify([scope, kind, baseOid, headOid])
  if (entries.has(key)) {
    const cached = entries.get(key) as T
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
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (!oldest.done) {
      entries.delete(oldest.value)
    }
  }
  return value
}
