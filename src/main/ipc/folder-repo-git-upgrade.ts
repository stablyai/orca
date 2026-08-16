import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import { notifyReposChanged } from './repos'
import { notifyWorktreesChanged } from './worktree-remote'
import { setFolderRepoGitUpgradeWakeListener } from './folder-repo-git-upgrade-wake'
import {
  createWorktreePollerWindowVisibility,
  WORKTREE_BASE_BACKSTOP_TICKS,
  WORKTREE_BASE_POLL_INTERVAL_MS,
  type WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

// Why: with no folder project registered there is nothing to stat, so back off until
// the next catalog mutation wakes the fast cadence.
const IDLE_POLL_INTERVAL_MS = WORKTREE_BASE_POLL_INTERVAL_MS * WORKTREE_BASE_BACKSTOP_TICKS

type UpgradeWatch = {
  store: Store
  mainWindow: BrowserWindow
  hasCandidates: boolean
  visibility: WorktreePollerWindowVisibility
  unsubscribeVisibility: () => void
  pollIntervalMs: number
  idlePollIntervalMs: number
  timer: ReturnType<typeof setTimeout> | null
  parkedWhileHidden: boolean
  disposed: boolean
}

let activeWatch: UpgradeWatch | null = null

// Why: git's verdict on a marker only changes when the marker does, and probing spawns git.
// A rejected marker must not respawn git every tick forever.
const rejectedMarkers = new Map<string, string>()

// Why: `git init` on an SSH host or behind a WSL UNC root is not observable with a
// local stat, and those roots are exactly the ones the base watcher already refuses
// to poll natively. Desktop-local folder projects are the reported case (#11477).
function isUpgradeCandidate(repo: Repo): boolean {
  return (
    isFolderRepo(repo) &&
    !repo.connectionId &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

/**
 * A folder project's extra workspaces are `worktreeMeta` rows keyed
 * `repoId::path::workspace:<uuid>`, and only the folder branch of the worktree listing
 * knows those keys exist. Flipping `kind` moves the repo onto the git branch, which lists
 * `git worktree list` (one path) and prunes every lineage id under the repo that is not in
 * it — so those workspaces vanish from the sidebar and their lineage is deleted. Migrating
 * them belongs to the listing code that owns both shapes, not to this watch, so refuse the
 * upgrade instead of destroying them. Such a project keeps working exactly as it does today.
 */
function hasExtraFolderWorkspaces(store: Store, repo: Repo): boolean {
  const prefix = `${repo.id}::${repo.path}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return Object.keys(store.getAllWorktreeMeta()).some((key) => key.startsWith(prefix))
}

/** Identity of the `.git` entry, or null when there is none. */
async function readGitMarkerSignature(repoPath: string): Promise<string | null> {
  try {
    const marker = await stat(join(repoPath, '.git'))
    return `${marker.mtimeMs}:${marker.ctimeMs}:${marker.ino}`
  } catch {
    return null
  }
}

function resolveRealPath(pathValue: string): string {
  try {
    return realpathSync(pathValue)
  } catch {
    return pathValue
  }
}

/**
 * Git's verdict on the folder, or null when it must stay a folder project.
 *
 * Two comparisons, deliberately at different strictness:
 * - Refuse unless the folder *is* the work-tree root. `.git` existing proves nothing —
 *   git accepts any path inside a work tree, so a stray marker in a subdirectory of
 *   another repo would otherwise flip a project whose path is not a repo root.
 * - Only hide external worktrees when the stored spelling also matches. Add Project
 *   stores the root as `rev-parse --show-toplevel` spells it while a folder project keeps
 *   the path the user picked; when a symlinked parent makes those differ, the root reads
 *   as an *external* worktree, and hiding those would hide the project's only workspace.
 */
function resolveUpgrade(repoPath: string): { externalWorktreeVisibility?: 'hide' } | null {
  if (!isGitRepo(repoPath)) {
    return null
  }
  const gitRoot = getGitRepoRoot(repoPath)
  if (resolveRealPath(gitRoot) !== resolveRealPath(repoPath)) {
    return null
  }
  return normalizeRuntimePathForComparison(gitRoot) === normalizeRuntimePathForComparison(repoPath)
    ? { externalWorktreeVisibility: 'hide' }
    : {}
}

type UpgradeResult = 'upgraded' | 'blocked' | 'rejected'

async function upgradeFolderRepo(watch: UpgradeWatch, repoId: string): Promise<UpgradeResult> {
  // Re-read after the marker stat: the repo can be removed or already upgraded mid-tick.
  const current = watch.store.getRepo(repoId)
  if (!current || !isUpgradeCandidate(current)) {
    return 'blocked'
  }
  if (hasExtraFolderWorkspaces(watch.store, current)) {
    return 'blocked'
  }
  const updates = resolveUpgrade(current.path)
  if (!updates) {
    return 'rejected'
  }
  const upgraded = watch.store.updateRepo(repoId, { kind: 'git', ...updates })
  if (!upgraded) {
    return 'upgraded'
  }
  // Adding a git project prepares its worktree root; an upgrade has to do the same.
  await prepareLocalWorktreeRootForRepo(watch.store, upgraded)
  invalidateAuthorizedRootsCache()
  if (watch.disposed) {
    return 'upgraded'
  }
  // Why: reuse the repo-mutation notifier so paired clients refetch too (#11994) and
  // the repo picks up the base/common-dir watchers it was skipped for as a folder.
  notifyReposChanged(watch.mainWindow)
  notifyWorktreesChanged(watch.mainWindow, repoId)
  return 'upgraded'
}

async function pollOnce(watch: UpgradeWatch): Promise<void> {
  // Why: a closed window on macOS leaves the app running with nothing to notify, and the
  // poller's visibility helper reports a destroyed window as visible on purpose so a
  // window-recreation gap cannot park it forever. Idle out instead of probing git.
  const candidates = watch.mainWindow.isDestroyed()
    ? []
    : watch.store.getRepos().filter(isUpgradeCandidate)
  watch.hasCandidates = candidates.length > 0
  const liveKeys = new Set<string>()
  for (const repo of candidates) {
    if (watch.disposed) {
      return
    }
    const key = normalizeRuntimePathForComparison(repo.path)
    liveKeys.add(key)
    const signature = await readGitMarkerSignature(repo.path)
    if (signature === null || rejectedMarkers.get(key) === signature) {
      continue
    }
    if ((await upgradeFolderRepo(watch, repo.id)) === 'rejected') {
      rejectedMarkers.set(key, signature)
    }
  }
  for (const key of rejectedMarkers.keys()) {
    if (!liveKeys.has(key)) {
      rejectedMarkers.delete(key)
    }
  }
}

function scheduleTick(watch: UpgradeWatch): void {
  const delay = watch.hasCandidates ? watch.pollIntervalMs : watch.idlePollIntervalMs
  watch.timer = setTimeout(() => void runTick(watch), delay)
  watch.timer.unref?.()
}

function wakeWatch(watch: UpgradeWatch): void {
  if (watch.disposed) {
    return
  }
  watch.hasCandidates = true
  if (!watch.timer) {
    return
  }
  clearTimeout(watch.timer)
  watch.timer = null
  scheduleTick(watch)
}

async function runTick(watch: UpgradeWatch): Promise<void> {
  watch.timer = null
  if (watch.disposed) {
    return
  }
  if (!watch.visibility.isWindowVisible()) {
    // Parked: the visibility listener resumes the loop, so no timer is rescheduled.
    watch.parkedWhileHidden = true
    return
  }
  try {
    await pollOnce(watch)
  } catch {
    // Transient fs error: retry on the next tick.
  }
  if (!watch.disposed) {
    scheduleTick(watch)
  }
}

/**
 * Polls `<repo>/.git` for every local folder project and upgrades it to a git repo
 * once an external `git init` lands, so git affordances appear without a restart.
 * Idempotent: a re-attached main window replaces the one the running watch holds.
 * Parks while the window is hidden — one stat per folder project per tick, never a
 * directory listing.
 */
export function startFolderRepoGitUpgradeWatch(
  store: Store,
  mainWindow: BrowserWindow,
  options: { pollIntervalMs?: number; idlePollIntervalMs?: number } = {}
): void {
  if (mainWindow.isDestroyed()) {
    return
  }
  if (activeWatch) {
    activeWatch.store = store
    activeWatch.mainWindow = mainWindow
    wakeWatch(activeWatch)
    return
  }
  const watch: UpgradeWatch = {
    store,
    mainWindow,
    // Why: assume work on the first tick rather than reading the store on the attach
    // path; the tick itself settles the cadence once it has seen the repo list.
    hasCandidates: true,
    visibility: createWorktreePollerWindowVisibility(() => watch.mainWindow),
    unsubscribeVisibility: () => {},
    pollIntervalMs: options.pollIntervalMs ?? WORKTREE_BASE_POLL_INTERVAL_MS,
    idlePollIntervalMs: options.idlePollIntervalMs ?? IDLE_POLL_INTERVAL_MS,
    timer: null,
    parkedWhileHidden: false,
    disposed: false
  }
  activeWatch = watch
  setFolderRepoGitUpgradeWakeListener(() => wakeWatch(watch))
  watch.unsubscribeVisibility = watch.visibility.onWindowBecameVisible(() => {
    if (watch.disposed || !watch.parkedWhileHidden) {
      return
    }
    watch.parkedWhileHidden = false
    void runTick(watch)
  })
  scheduleTick(watch)
}

export function stopFolderRepoGitUpgradeWatch(): void {
  const watch = activeWatch
  if (!watch) {
    return
  }
  activeWatch = null
  watch.disposed = true
  setFolderRepoGitUpgradeWakeListener(null)
  rejectedMarkers.clear()
  if (watch.timer) {
    clearTimeout(watch.timer)
    watch.timer = null
  }
  watch.unsubscribeVisibility()
}
