import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  folderRepoHasExtraWorkspaces,
  promoteFolderRepoToGit,
  readRemoteGitMarkerSignature,
  resolveLocalFolderGitUpgrade,
  resolveRemoteFolderGitUpgrade
} from '../folder-repo-git-promotion'
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

// Why: a local `stat` cannot observe `git init` on an SSH host, a WSL UNC root, or a
// runtime-owned filesystem. Desktop-local folder projects are the cheap-stat case
// (#11477); SSH folders are probed on the execution host instead of guessed locally.
function isLocalFilesystemCandidate(repo: Repo): boolean {
  return (
    isFolderRepo(repo) &&
    !repo.connectionId &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

function isSshCandidate(repo: Repo): boolean {
  return isFolderRepo(repo) && Boolean(repo.connectionId)
}

function isUpgradeCandidate(repo: Repo): boolean {
  return isLocalFilesystemCandidate(repo) || isSshCandidate(repo)
}

function candidateKey(repo: Repo): string {
  return `${repo.connectionId ?? 'local'}\0${normalizeRuntimePathForComparison(repo.path)}`
}

/** Identity of the local `.git` entry, or null when there is none. */
async function readLocalGitMarkerSignature(repoPath: string): Promise<string | null> {
  try {
    const marker = await stat(join(repoPath, '.git'))
    return `${marker.mtimeMs}:${marker.ctimeMs}:${marker.ino}`
  } catch {
    return null
  }
}

type UpgradeResult = 'upgraded' | 'blocked' | 'rejected'

function notifyPromotion(watch: UpgradeWatch, repoId: string): void {
  if (watch.disposed) {
    return
  }
  // Why: reuse the repo-mutation notifier so paired clients refetch too (#11994) and
  // the repo picks up the base/common-dir watchers it was skipped for as a folder.
  notifyReposChanged(watch.mainWindow)
  notifyWorktreesChanged(watch.mainWindow, repoId)
}

async function upgradeLocalFolderRepo(watch: UpgradeWatch, repo: Repo): Promise<UpgradeResult> {
  const current = watch.store.getRepo(repo.id)
  if (!current || !isLocalFilesystemCandidate(current)) {
    return 'blocked'
  }
  if (folderRepoHasExtraWorkspaces(watch.store, current)) {
    return 'blocked'
  }
  const updates = resolveLocalFolderGitUpgrade(current.path)
  if (!updates) {
    return 'rejected'
  }
  const upgraded = await promoteFolderRepoToGit(watch.store, current.id, updates)
  if (!upgraded) {
    return 'upgraded'
  }
  notifyPromotion(watch, current.id)
  return 'upgraded'
}

async function upgradeSshFolderRepo(watch: UpgradeWatch, repo: Repo): Promise<UpgradeResult> {
  const current = watch.store.getRepo(repo.id)
  if (!current || !isSshCandidate(current)) {
    return 'blocked'
  }
  if (folderRepoHasExtraWorkspaces(watch.store, current)) {
    return 'blocked'
  }
  const probe = await resolveRemoteFolderGitUpgrade(current)
  if (probe.status === 'unverifiable') {
    return 'blocked'
  }
  if (probe.status === 'rejected') {
    return 'rejected'
  }
  const upgraded = await promoteFolderRepoToGit(watch.store, current.id, probe.updates)
  if (!upgraded) {
    return 'upgraded'
  }
  notifyPromotion(watch, current.id)
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
    const key = candidateKey(repo)
    liveKeys.add(key)
    if (isSshCandidate(repo)) {
      const marker = await readRemoteGitMarkerSignature(repo)
      if (marker.status !== 'present' || rejectedMarkers.get(key) === marker.signature) {
        continue
      }
      if ((await upgradeSshFolderRepo(watch, repo)) === 'rejected') {
        rejectedMarkers.set(key, marker.signature)
      }
      continue
    }
    const signature = await readLocalGitMarkerSignature(repo.path)
    if (signature === null || rejectedMarkers.get(key) === signature) {
      continue
    }
    if ((await upgradeLocalFolderRepo(watch, repo)) === 'rejected') {
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
 * SSH folders are probed on the execution host (`fs.stat` then `git.isGitRepo`); a
 * missing provider or thrown probe is unverifiable, never "not a repo".
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
