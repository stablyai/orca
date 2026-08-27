import { statSync } from 'node:fs'
import { gitExecFileSync } from '../../../git/runner'
import type { OrchestrationDb } from '../db'

/** Blocker 1 — what the RUNTIME sees, as opposed to what a worker says it sees.
 *
 *  The completion gate used to compare `claim.claimedSha` against
 *  `claim.headSha` and read `claim.worktreeClean` — every one of those fields
 *  arrives in the worker's own payload, so a worker that sent two equal SHAs
 *  and `worktreeClean: true` passed a gate that had observed nothing at all.
 *
 *  Everything here is read by the runtime from the worktree and the Dispatch
 *  record. A worker may still SAY what it believes changed; that claim is only
 *  ever used to detect a mismatch, never as evidence.
 */

export type ObservedCompletion = {
  /** The worktree the Dispatch actually ran in, from the worker record. */
  worktreePath: string | null
  /** HEAD as the runtime read it. Null when the tree is unreadable. */
  headSha: string | null
  /** Working-tree cleanliness as the runtime read it. */
  clean: boolean | null
  /** Paths the runtime derived from Git, not from the worker's payload. */
  changedFiles: readonly string[]
  /** False when the runtime could not read the tree at all: fail closed. */
  observable: boolean
  /** Why it could not be observed, when it could not. */
  reason: string | null
  observedAt: string
}

function unobservable(reason: string, worktreePath: string | null): ObservedCompletion {
  return {
    worktreePath,
    headSha: null,
    clean: null,
    changedFiles: [],
    observable: false,
    reason,
    observedAt: new Date().toISOString()
  }
}

/** Worktree ids are `<repoId>::<absolutePath>`. */
export function worktreePathForDispatch(db: OrchestrationDb, dispatchId: string): string | null {
  const worktreeId = db.getWorkerDispatch(dispatchId)?.worktree_id
  const separator = worktreeId?.indexOf('::') ?? -1
  return worktreeId && separator !== -1 ? worktreeId.slice(separator + 2) : null
}

export function observeCompletion(args: {
  db: OrchestrationDb
  dispatchId: string
  /** The commit the Dispatch started from, when the runtime recorded one. */
  baseSha?: string | null
}): ObservedCompletion {
  const worktreePath = worktreePathForDispatch(args.db, args.dispatchId)
  if (!worktreePath) {
    return unobservable('The Dispatch has no recorded worktree, so nothing can be observed.', null)
  }
  try {
    if (!statSync(worktreePath).isDirectory()) {
      return unobservable(`${worktreePath} is not a directory.`, worktreePath)
    }
  } catch {
    return unobservable(`${worktreePath} is not readable by this runtime.`, worktreePath)
  }
  let headSha: string
  try {
    headSha = gitExecFileSync(['rev-parse', 'HEAD'], { cwd: worktreePath }).trim()
  } catch (error) {
    return unobservable(`git rev-parse failed in ${worktreePath}: ${String(error)}`, worktreePath)
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return unobservable(`git rev-parse returned no usable commit in ${worktreePath}.`, worktreePath)
  }
  let clean: boolean
  try {
    clean = gitExecFileSync(['status', '--porcelain'], { cwd: worktreePath }).trim().length === 0
  } catch (error) {
    return unobservable(`git status failed in ${worktreePath}: ${String(error)}`, worktreePath)
  }
  return {
    worktreePath,
    headSha,
    clean,
    changedFiles: deriveChangedFiles(worktreePath, args.baseSha ?? null, headSha),
    observable: true,
    reason: null,
    observedAt: new Date().toISOString()
  }
}

/** The changed-file set as GIT reports it. Falls back to the commit's own diff
 *  when the runtime never recorded where the Dispatch started. */
function deriveChangedFiles(
  worktreePath: string,
  baseSha: string | null,
  headSha: string
): readonly string[] {
  const range =
    baseSha && baseSha !== headSha ? `${baseSha}..${headSha}` : `${headSha}^..${headSha}`
  try {
    return gitExecFileSync(['diff', '--name-only', range], { cwd: worktreePath })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    // A root commit has no parent; that is not an error, it is an empty range.
    return []
  }
}
