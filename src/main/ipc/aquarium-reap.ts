import { ipcMain } from 'electron'
import { basename, join } from 'path'
import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { promisify } from 'util'
import { AQUARIUM_REAP_CHANNEL, type AquariumReapRequest, type AquariumReapResult } from '../../shared/aquarium-reap'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'

// Why: on macOS `/var` is a symlink to `/private/var`. Git reports the
// resolved realpath while the renderer passes the symlinked path from the
// filesystem watcher. The canonical comparator normalizes `/private/tmp` but not
// `/private/var`, and mkdtemp resolution is inconsistent — so fall back to a
// basename match (worktree leaf names are unique per repo) for robustness.

// T7/T8 closure (2026-08-03): the Aquarium Reap verb's disposal backend.
// The renderer sends ONLY worktree identities; every safety decision is
// re-derived here. The client-side deny gate is UX sugar and is never trusted.
//
// Disposal sequence (validated on a throwaway repo before this landed):
//   git worktree remove --force <path>   # evaporates a prunable/ghost
//   git worktree prune                   # drops orphaned .git/worktrees/<n> stub

const execFileAsync = promisify(execFile)

export type AquariumReapHandlerDeps = {
  /** Owner check — returns true if the local process may reap this path. */
  isOwnedByLocal?: (worktreePath: string) => boolean
  /** Active lock check — returns true if another process holds the worktree. */
  isActiveLocked?: (worktreePath: string) => boolean
}

function defaultIsOwnedByLocal(worktreePath: string): boolean {
  // On a single-user dev machine the local process owns its own worktrees.
  // Real multi-user hardening would stat the dir owner; the contract refuses
  // not-found + guard-block regardless, so a false "owned" here only widens
  // the reapable set, never bypasses a hard deny.
  try {
    const stat = statSync(worktreePath, { throwIfNoEntry: true })
    return stat.uid === process.getuid()
  } catch {
    // If we can't stat the path (e.g. ghost worktree dir is gone), fall back
    // to true — the not-found gate already handles missing worktrees, and
    // guard-block covers active sessions. Ownership is a secondary check.
    return true
  }
}

function defaultIsActiveLocked(worktreePath: string): boolean {
  // No lock file present → not locked. The spike implements this via O_EXCL
  // lock files (bookbag acquire_lock parity). A missing lock file means no
  // active session holds the worktree.
  const lockPath = join(worktreePath, '.aquarium.lock')
  return existsSync(lockPath)
}

/** Ghost-tolerant worktree listing: `listWorktrees` does sparse-checkout
 *  stat-ing that throws on a missing (pruned) worktree dir, so we parse the
 *  raw `git worktree list` output ourselves and tolerate absent dirs. */
async function listGhostTolerantWorktrees(
  repoPath: string
): Promise<{ path: string; branch?: string; head?: string }[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: repoPath
  })
  const known: { path: string; branch?: string; head?: string }[] = []
  for (const block of stdout.split('\0').filter(Boolean)) {
    const lines = block.split('\n').filter(Boolean)
    if (lines.length === 0) {
      continue
    }
    const entry: { path: string; branch?: string; head?: string } = { path: '' }
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        entry.path = line.slice('worktree '.length).trim()
      } else if (line.startsWith('branch ')) {
        entry.branch = line.slice('branch '.length).trim()
      } else if (line.startsWith('HEAD ')) {
        entry.head = line.slice('HEAD '.length).trim()
      }
    }
    if (entry.path) {
      known.push(entry)
    }
  }
  return known
}

export async function reapAquariumWorktrees(
  request: AquariumReapRequest,
  deps: AquariumReapHandlerDeps = {}
): Promise<AquariumReapResult> {
  const { repoPath, worktreePaths } = request
  const isOwnedByLocal = deps.isOwnedByLocal ?? defaultIsOwnedByLocal
  const isActiveLocked = deps.isActiveLocked ?? defaultIsActiveLocked

  const reaped: string[] = []
  const denied: AquariumReapResult['denied'] = []
  const failed: AquariumReapResult['failed'] = []

  let known: Awaited<ReturnType<typeof listGhostTolerantWorktrees>>
  try {
    known = await listGhostTolerantWorktrees(repoPath)
  } catch {
    // If we cannot even list, refuse everything rather than guess.
    for (const path of worktreePaths) {
      denied.push({ path, reason: 'not-found', detail: 'worktree list failed' })
    }
    return { reaped, denied, failed }
  }

  for (const path of worktreePaths) {
    const match = known.find(
      (wt) => areWorktreePathsEqual(wt.path, path) || basename(wt.path) === basename(path)
    )
    if (!match) {
      denied.push({ path, reason: 'not-found' })
      continue
    }
    if (!isOwnedByLocal(path)) {
      denied.push({ path, reason: 'owner-uid' })
      continue
    }
    if (isActiveLocked(path)) {
      denied.push({ path, reason: 'guard-block', detail: 'worktree is locked by an active session' })
      continue
    }

    try {
      // Evaporate the ghost worktree. Prune runs once after the loop so a
      // prior removal's prune doesn't strip the next worktree's admin stub
      // before its own removal runs (which would make that removal fail).
      //
      // We target `match.path` (the path `git` itself reported in
      // `git worktree list`) rather than the raw requested `path`: the match
      // may have been resolved via the basename fallback across the macOS
      // `/var` <-> `/private/var` symlink, so `match.path` is the canonical
      // registered location and removes any ambiguity about what gets
      // deleted. We still report the *requested* `path` back to the caller.
      await execFileAsync('git', ['worktree', 'remove', '--force', match.path], {
        cwd: repoPath
      })
      reaped.push(path)
    } catch (error) {
      failed.push({
        path,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // Single sweep: drop every orphaned .git/worktrees/<name> admin stub left by
  // the removals above.
  if (reaped.length > 0) {
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoPath })
    } catch (error) {
      failed.push({
        path: repoPath,
        error: `prune failed: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  return { reaped, denied, failed }
}

export function registerAquariumReapHandlers(deps: AquariumReapHandlerDeps = {}): void {
  ipcMain.removeHandler(AQUARIUM_REAP_CHANNEL)
  ipcMain.handle(AQUARIUM_REAP_CHANNEL, (_event, request: AquariumReapRequest) =>
    reapAquariumWorktrees(request, deps)
  )
}
