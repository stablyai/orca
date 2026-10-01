// The spare checkouts this process holds: at most one per repo per Git host, built while the create
// composer is open on an idle machine. A create claims one only when it is completely ready for the
// create's base commit; it never waits on one (rule 1) and never builds another (rule 3).
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../shared/worktree/create-preparation'
import { createGitOperationExecutor } from './git/command-runner/git-operation-executor'
import { prepareWorktreeCreateCheckout } from './git/worktree-create-preparation'
import { addOwnedSpareId, releaseOwnedSpareId } from './git/worktree-create-spare-ids'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import { toHostFilesystemPath } from './host-tree-removal'
import { parseWslPath } from './wsl'
import { recordSpareBuildDuration } from './worktree-create-spare-gate'
import { hasPendingSpareDiscards, scheduleSpareDiscard } from './worktree-create-spare-discard'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
/** A disk bound: each spare is a full checkout, so at most this many repos keep one at a time. */
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3

/** A spare's own git runs at status priority, below anything a user is waiting on. */
export const worktreePreparationGit = createGitOperationExecutor('status')

export type SpareState = 'building' | 'ready' | 'abandoned'

export type SpareEntry = {
  id: string
  key: string
  repoPath: string
  workspaceRootKey: string
  oid: string
  preparedPath: string
  options: GitWorktreeExecOptions
  /** Whether the handover runs `post-checkout` through `git hook run`. */
  hookRun: boolean
  /** The repo's hooks directory, absolute in Git's own path space, for that `git hook run`. */
  hooksPath?: string
  /** Set once the spare's `worktree add` ran; before that there is nothing to remove. */
  registered: boolean
  state: SpareState
  controller: AbortController
  expiration: ReturnType<typeof setTimeout>
}

export type StartSpareArgs = {
  repoPath: string
  workspaceRoot: string
  oid: string
  hookRun: boolean
  hooksPath?: string
  options: GitWorktreeExecOptions
}

const spares = new Map<string, SpareEntry>()
// Repos whose last request built nothing because the handover could not honor `post-checkout`.
const hookUnsupportedRepos = new Set<string>()
// Repos whose spare was still building when the latest create started, for its miss reason. Reset
// at every create start, so a spare stopped for one create never labels a later create elsewhere.
// Overlapping creates can lose a label, never misattribute one.
const stoppedForCreate = new Set<string>()
// Builds whose git may still be running, abandoned WSL ones included.
let buildsRunning = 0
let quitting = false

/** Case-folded on Windows, so the building and claiming sides key on the same path. */
export function preparationPathKey(path: string): string {
  return isWindowsAbsolutePathLike(path)
    ? win32.normalize(path).toLowerCase()
    : posix.normalize(path)
}

/** One spare per repo per Git host. */
export function spareRepoKey(repoPath: string, wslDistro?: string): string {
  return `${preparationPathKey(repoPath)}\0${wslDistro ?? ''}`
}

/** On WSL the checkout runs behind `wsl.exe`; killing that is not proven to stop the Linux git. */
function stopsByKilling(entry: SpareEntry): boolean {
  return !entry.options.wslDistro && !parseWslPath(entry.repoPath)
}

function pathOps(path: string): Pick<typeof posix, 'join'> {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

function discard(entry: SpareEntry): void {
  if (!entry.registered) {
    releaseOwnedSpareId(entry.id)
    return
  }
  scheduleSpareDiscard({
    id: entry.id,
    repoPath: entry.repoPath,
    path: entry.preparedPath,
    options: entry.options
  })
}

/**
 * Takes the spare out of service at once. A ready spare is discarded now; a building one is stopped
 * (native: its recorded git child is killed; WSL: left to finish) and discarded when its build ends.
 */
function abandonSpare(entry: SpareEntry): void {
  if (spares.get(entry.key) === entry) {
    spares.delete(entry.key)
  }
  clearTimeout(entry.expiration)
  const wasReady = entry.state === 'ready'
  entry.state = 'abandoned'
  if (wasReady) {
    discard(entry)
  } else if (stopsByKilling(entry)) {
    entry.controller.abort()
  }
}

export function findSpare(repoKey: string): SpareEntry | undefined {
  return spares.get(repoKey)
}

export function noteSpareHookUnsupported(repoKey: string): void {
  hookUnsupportedRepos.add(repoKey)
}

export function isSpareHookUnsupported(repoKey: string): boolean {
  return hookUnsupportedRepos.has(repoKey)
}

/** Building spares or discards still running; repo maintenance must not start meanwhile. */
export function hasSpareWork(): boolean {
  return hasPendingSpareDiscards() || buildsRunning > 0
}

/** Every create start, machine-wide: an unfinished spare is a second checkout on the same disk. */
export function abandonUnfinishedSpares(): void {
  stoppedForCreate.clear()
  // Deleting the current entry while iterating a Map is safe.
  for (const entry of spares.values()) {
    if (entry.state === 'building') {
      stoppedForCreate.add(entry.key)
      abandonSpare(entry)
    }
  }
}

/** Whether a create start stopped this repo's unfinished spare; reported once. */
export function takeSpareStoppedForCreate(repoKey: string): boolean {
  return stoppedForCreate.delete(repoKey)
}

export function abandonRepoSpare(repoKey: string): void {
  const entry = spares.get(repoKey)
  if (entry) {
    abandonSpare(entry)
  }
}

export type SpareTake =
  | { status: 'taken'; entry: SpareEntry }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

/** Synchronous, so no other create can take the same spare. */
export function takeReadySpare(
  entry: SpareEntry,
  targetHead: string,
  workspaceRootKey: string
): SpareTake {
  if (spares.get(entry.key) !== entry) {
    return { status: 'miss', reason: 'none' }
  }
  if (entry.state !== 'ready') {
    return { status: 'miss', reason: 'not_ready' }
  }
  if (entry.workspaceRootKey !== workspaceRootKey) {
    return { status: 'miss', reason: 'workspace_root_mismatch' }
  }
  if (entry.oid !== targetHead) {
    // Why not move it: a reset to another commit costs as much as the diff, which nothing bounds.
    abandonSpare(entry)
    return { status: 'miss', reason: 'base_moved' }
  }
  spares.delete(entry.key)
  clearTimeout(entry.expiration)
  return { status: 'taken', entry }
}

export function isSpareQuitting(): boolean {
  return quitting
}

/** Committed quit: stop every spare build and refuse new ones; the next sweep reclaims leftovers. */
export function abortSparesForQuit(): void {
  quitting = true
  for (const entry of spares.values()) {
    if (entry.state === 'building' && stopsByKilling(entry)) {
      entry.controller.abort()
    }
  }
}

async function buildSpare(entry: SpareEntry, workspaceRoot: string): Promise<boolean> {
  const preparationRoot = pathOps(workspaceRoot).join(
    workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY
  )
  await mkdir(toHostFilesystemPath(preparationRoot), { recursive: true })
  const startedAt = Date.now()
  const ready = await prepareWorktreeCreateCheckout(
    entry.repoPath,
    entry.preparedPath,
    entry.oid,
    createWorktreePreparationLockReason(entry.id),
    {
      ...entry.options,
      signal: entry.controller.signal,
      // A WSL spare is never killed, but one abandoned before its checkout must not start it.
      isCancelled: () => entry.state === 'abandoned',
      onRegistered: () => {
        entry.registered = true
      }
    }
  )
  if (ready) {
    recordSpareBuildDuration(entry.key, Date.now() - startedAt)
  }
  return ready
}

/** Starts building; nothing awaits the build. The caller has already checked the start gate. */
export function startSpare(args: StartSpareArgs): void {
  if (quitting) {
    return
  }
  const key = spareRepoKey(args.repoPath, args.options.wslDistro)
  const existing = spares.get(key)
  if (existing) {
    abandonSpare(existing)
  }
  // Map order is insertion order, so the first entry is the oldest spare.
  for (const oldest of spares.values()) {
    if (spares.size < WORKTREE_CREATE_PREPARATION_LIMIT) {
      break
    }
    abandonSpare(oldest)
  }
  hookUnsupportedRepos.delete(key)
  stoppedForCreate.delete(key)
  const id = `${process.pid}-${randomUUID()}`
  const root = pathOps(args.workspaceRoot).join(
    args.workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY
  )
  const entry: SpareEntry = {
    id,
    key,
    repoPath: args.repoPath,
    workspaceRootKey: preparationPathKey(args.workspaceRoot),
    oid: args.oid,
    preparedPath: pathOps(root).join(root, id),
    options: args.options,
    hookRun: args.hookRun,
    ...(args.hooksPath ? { hooksPath: args.hooksPath } : {}),
    registered: false,
    state: 'building',
    controller: new AbortController(),
    expiration: setTimeout(() => abandonSpare(entry), WORKTREE_CREATE_PREPARATION_TTL_MS)
  }
  entry.expiration.unref?.()
  addOwnedSpareId(id)
  spares.set(key, entry)
  buildsRunning += 1
  void worktreePreparationGit
    .run(() => buildSpare(entry, args.workspaceRoot))
    .catch((error: unknown) => {
      if (!entry.controller.signal.aborted) {
        console.warn(`[worktree-create] spare checkout failed for ${args.repoPath}`, error)
      }
      return false
    })
    .then((ready) => {
      buildsRunning -= 1
      if (ready && entry.state === 'building') {
        entry.state = 'ready'
        return
      }
      if (spares.get(key) === entry) {
        spares.delete(key)
        clearTimeout(entry.expiration)
      }
      entry.state = 'abandoned'
      discard(entry)
    })
}

export function _resetSparePoolForTests(): void {
  for (const entry of spares.values()) {
    clearTimeout(entry.expiration)
    entry.controller.abort()
  }
  spares.clear()
  hookUnsupportedRepos.clear()
  stoppedForCreate.clear()
  buildsRunning = 0
  quitting = false
}
