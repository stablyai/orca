// Starts a spare checkout when the create composer has refreshed its base on an idle machine. The
// only caller is the composer prefetch (IPC `worktrees:prefetchCreateBase`, RPC
// `worktree.prefetchCreateBase`); nothing re-arms one after a create (rule 3).
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'
import { checkSparePostCheckoutHook } from './git/worktree-create-preparation'
import { resolveWorktreeBaseCommitOid } from './git/worktree-base-ref-probe'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import {
  abandonRepoSpare,
  findSpare,
  isSpareQuitting,
  noteSpareHookUnsupported,
  preparationPathKey,
  spareRepoKey,
  startSpare,
  worktreePreparationGit
} from './worktree-create-preparation-pool'
import {
  localCreatesStarted,
  mayAbandonSpareForBaseChange,
  recordSpareAbandonedForBaseChange,
  spareStartRefusal,
  type SpareStartRefusal
} from './worktree-create-spare-gate'

/** Only the last base picked in a quiet stretch builds, so flipping through bases costs nothing. */
export const SPARE_REQUEST_DEBOUNCE_MS = 2_000

/** Taken when the composer's prefetch arrives, before its fetch, so later picks win. */
export type SpareRequestTicket = {
  repoKey: string
  seq: number
  createsStarted: number
  options: GitWorktreeExecOptions
}

type SpareSkipReason =
  | 'quitting'
  | 'superseded'
  | 'create_started'
  | 'abandon_window'
  | SpareStartRefusal
  | 'hook_unsupported'

const pendingRequests = new Map<string, ReturnType<typeof setTimeout>>()
const runningRequests = new Set<Promise<void>>()
const latestSeqByRepo = new Map<string, number>()

function skip(repoPath: string, reason: SpareSkipReason): void {
  console.info(`[worktree-create] no spare checkout for ${repoPath}: ${reason}`)
}

/** Null for a repo that never gets a spare (SSH, folder, a runtime awaiting repair, quitting). */
export function beginWorktreeCreateSpareRequest(
  store: Store,
  repo: Repo
): SpareRequestTicket | null {
  if (repo.connectionId || isFolderRepo(repo) || isSpareQuitting()) {
    return null
  }
  let options: GitWorktreeExecOptions
  try {
    options = getLocalProjectWorktreeGitOptions(store, repo)
  } catch {
    return null
  }
  const repoKey = spareRepoKey(repo.path, options.wslDistro)
  const seq = (latestSeqByRepo.get(repoKey) ?? 0) + 1
  latestSeqByRepo.set(repoKey, seq)
  return { repoKey, seq, createsStarted: localCreatesStarted(), options }
}

/** Why this request may no longer build: a later pick, a create since it arrived, or quit. */
function staleReason(ticket: SpareRequestTicket): SpareSkipReason | null {
  if (isSpareQuitting()) {
    return 'quitting'
  }
  if (latestSeqByRepo.get(ticket.repoKey) !== ticket.seq) {
    return 'superseded'
  }
  // A create since the request arrived ends it: building after that create would be a re-arm.
  return localCreatesStarted() === ticket.createsStarted ? null : 'create_started'
}

/** Synchronous and fire-and-forget: the composer never waits on a spare. */
export function requestWorktreeCreateSpare(
  store: Store,
  repo: Repo,
  baseBranch: string,
  ticket: SpareRequestTicket
): void {
  const stale = staleReason(ticket)
  if (stale) {
    skip(repo.path, stale)
    return
  }
  clearTimeout(pendingRequests.get(ticket.repoKey))
  const timer = setTimeout(() => {
    pendingRequests.delete(ticket.repoKey)
    const running = worktreePreparationGit
      .run(() => startRequestedSpare(store, repo, baseBranch, ticket))
      .catch((error: unknown) => {
        console.warn(`[worktree-create] could not start a spare checkout for ${repo.path}`, error)
      })
      .finally(() => runningRequests.delete(running))
    runningRequests.add(running)
  }, SPARE_REQUEST_DEBOUNCE_MS)
  timer.unref?.()
  pendingRequests.set(ticket.repoKey, timer)
}

async function resolveSpareCommit(
  repoPath: string,
  baseBranch: string,
  options: GitWorktreeExecOptions
): Promise<string | null> {
  // The create's own resolvers, so the spare lands on exactly the commit a plain add would use.
  let oid: string | null = null
  const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, async (qualifiedRef) => {
    oid = await resolveWorktreeBaseCommitOid(repoPath, qualifiedRef, options)
    return oid !== null
  })
  // A fully qualified ref or a commit id is passed through unprobed.
  return oid ?? (await resolveWorktreeBaseCommitOid(repoPath, effectiveBase, options))
}

async function startRequestedSpare(
  store: Store,
  repo: Repo,
  baseBranch: string,
  ticket: SpareRequestTicket
): Promise<void> {
  const { repoKey, options } = ticket
  // The gate comes before anything is abandoned: a refused request keeps the existing spare.
  const refused = staleReason(ticket) ?? spareStartRefusal()
  if (refused) {
    skip(repo.path, refused)
    return
  }
  const workspaceRoot = await computeWorkspaceRootAsync(
    repo.path,
    getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
  )
  const oid = await resolveSpareCommit(repo.path, baseBranch, options)
  if (!oid) {
    return
  }
  const existing = findSpare(repoKey)
  const sameSpare =
    existing?.oid === oid && existing.workspaceRootKey === preparationPathKey(workspaceRoot)
  if (sameSpare) {
    return
  }
  if (existing && !mayAbandonSpareForBaseChange(repoKey)) {
    skip(repo.path, 'abandon_window')
    return
  }
  const hook = await checkSparePostCheckoutHook(repo.path, options)
  if (!hook.honorable) {
    noteSpareHookUnsupported(repoKey)
    skip(repo.path, 'hook_unsupported')
    return
  }
  // Re-checked after the awaits: a create may have started, or another request replaced the spare.
  const late = staleReason(ticket) ?? spareStartRefusal()
  if (late || findSpare(repoKey) !== existing) {
    skip(repo.path, late ?? 'superseded')
    return
  }
  if (existing) {
    recordSpareAbandonedForBaseChange(repoKey)
    abandonRepoSpare(repoKey)
  }
  startSpare({
    repoPath: repo.path,
    workspaceRoot,
    oid,
    hookRun: hook.hookRun,
    ...(hook.hooksPath ? { hooksPath: hook.hooksPath } : {}),
    options
  })
}

export async function _whenSpareRequestsSettledForTests(): Promise<void> {
  await Promise.all(runningRequests)
}

export function _resetSpareRequestsForTests(): void {
  for (const timer of pendingRequests.values()) {
    clearTimeout(timer)
  }
  pendingRequests.clear()
  latestSeqByRepo.clear()
}
