import { statSync } from 'node:fs'
import { gitExecFileSync } from '../../../git/runner'
import type { OrchestrationDb } from '../db'
import { parseWorkerTerminalHostScope } from '../worker-terminal-process-liveness'

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
function recordedWorktreePath(db: OrchestrationDb, dispatchId: string): string | null {
  const worktreeId = db.getWorkerDispatch(dispatchId)?.worktree_id
  const separator = worktreeId?.indexOf('::') ?? -1
  return worktreeId && separator !== -1 ? worktreeId.slice(separator + 2) : null
}

/** The worktree path THIS runtime may answer for.
 *
 *  Null when the Dispatch executes elsewhere. The recorded path describes the
 *  EXECUTING host's filesystem, and an identical path can exist here too — so
 *  reading it locally does not fail, it answers confidently for the wrong
 *  repository. Every caller that resolves a Dispatch to a local directory has
 *  to go through this, not the raw column. */
export function worktreePathForDispatch(db: OrchestrationDb, dispatchId: string): string | null {
  return executesElsewhere(db, dispatchId) ? null : recordedWorktreePath(db, dispatchId)
}

/** True when this runtime is NOT the execution host for the Dispatch.
 *
 *  Why it gates everything below: the execution host owns everything that
 *  touches execution, and a remote worktree path can also exist on the client,
 *  so running git here would answer confidently for the WRONG repository. That
 *  is the one failure worse than declining to answer.
 *  See docs/reference/ssh-execution-boundary.md. */
function executesElsewhere(db: OrchestrationDb, dispatchId: string): string | null {
  const scope = parseWorkerTerminalHostScope(
    db.getWorkerTerminalResourceByOwner(dispatchId)?.host_scope ?? null
  )
  if (scope?.kind === 'ssh') {
    return `The Dispatch executes on SSH target ${scope.targetId}, which owns its tree; this client must not answer for it.`
  }
  if (scope?.kind === 'wsl') {
    return `The Dispatch executes inside WSL distro ${scope.distro}, which owns its tree; this client must not answer for it.`
  }
  // A federated Dispatch never gets a worker_terminal_resources row, so there is
  // no host_scope to read — yet its recorded worktree id carries the REMOTE
  // host's absolute path. Without this the coordinator ran local Git against
  // that path and, whenever it happened to exist here too, answered for a
  // completely unrelated repository.
  if (db.getFederatedDispatch(dispatchId)) {
    return `The Dispatch executes on the federated environment it was attached to, which owns its tree; this coordinator must not answer for it.`
  }
  return null
}

export function observeCompletion(args: {
  db: OrchestrationDb
  dispatchId: string
  /** The commit the Dispatch started from, when the runtime recorded one. */
  baseSha?: string | null
}): ObservedCompletion {
  const elsewhere = executesElsewhere(args.db, args.dispatchId)
  if (elsewhere) {
    return unobservable(elsewhere, recordedWorktreePath(args.db, args.dispatchId))
  }
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
  const changedFiles = deriveChangedFiles(worktreePath, args.baseSha ?? null, headSha)
  if (changedFiles === null) {
    // "Could not read the diff" must never read as "nothing changed".
    return unobservable(
      `git diff ${args.baseSha}..${headSha} failed in ${worktreePath}, so the changed-file set cannot be proven.`,
      worktreePath
    )
  }
  return {
    worktreePath,
    headSha,
    clean,
    changedFiles,
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
): readonly string[] | null {
  // An explicit base is authoritative even when it equals HEAD: that is a real
  // no-change Dispatch and its changed-file set is empty. Falling back to the
  // HEAD commit's own diff in that case attributed pre-existing work to this
  // worker and could send unrelated files into review/gate invalidation.
  const range = baseSha ? `${baseSha}..${headSha}` : `${headSha}^..${headSha}`
  try {
    return gitExecFileSync(['diff', '--name-only', range], { cwd: worktreePath })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    // A root commit has no parent; that is an empty range, not an error — but
    // ONLY on the no-base fallback. With a base recorded, a diff failure means
    // an unreachable base or an unreadable tree, and reporting that as "nothing
    // changed" let a completion settle claiming it delivered no files.
    if (baseSha) {
      return null
    }
    return []
  }
}
