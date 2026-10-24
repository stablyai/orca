import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { findExtraFolderWorkspaceIds } from '../folder-workspace-meta-presence'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { resolveFolderToGitConversion } from '../folder-repo-git-conversion'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import { notifyReposChanged } from './repos/repos-changed-notification'
import { notifyWorktreesChanged } from './worktree-remote'
import { setFolderRepoGitUpgradeWakeListener } from './folder-repo-git-upgrade-wake'
import {
  createWorktreePollerWindowVisibility,
  WORKTREE_BASE_POLL_INTERVAL_MS,
  type WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { WORKTREE_BASE_BACKSTOP_TICKS } from './worktree-base-directory-marker-poller'

// Empty catalogs idle until mutations wake fast polling.
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

// Re-probe rejected Git markers only after their identity changes.
const rejectedMarkers = new Map<string, string>()

// Local stat cannot observe SSH roots; WSL UNC roots follow their existing runtime watch policy.
function isUpgradeCandidate(repo: Repo): boolean {
  return (
    isFolderRepo(repo) &&
    !repo.connectionId &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

// The repo write would refuse upgrades hiding extra folder workspaces; skip without logging an error.
function hasExtraFolderWorkspaces(store: Store, repo: Repo): boolean {
  return findExtraFolderWorkspaceIds(repo, store.getAllWorktreeMeta()).length > 0
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

/** Hide external worktrees only when stored and Git root spellings match, or symlinked projects could lose their only workspace. */
async function resolveUpgrade(
  repoPath: string
): Promise<{ folderUpgradeGitRootPath?: string; externalWorktreeVisibility?: 'hide' } | null> {
  const conversion = await resolveFolderToGitConversion(repoPath)
  if (!conversion) {
    return null
  }
  return conversion.rootSpellingMatches
    ? { ...conversion.updates, externalWorktreeVisibility: 'hide' }
    : conversion.updates
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
  const inspectedPath = current.path
  const updates = await resolveUpgrade(inspectedPath)
  const latest = watch.store.getRepo(repoId)
  if (
    watch.disposed ||
    !latest ||
    !isUpgradeCandidate(latest) ||
    latest.path !== inspectedPath ||
    hasExtraFolderWorkspaces(watch.store, latest)
  ) {
    return 'blocked'
  }
  if (!updates) {
    return 'rejected'
  }
  const upgraded = watch.store.updateRepo(latest, { kind: 'git', ...updates })
  if (!upgraded) {
    return 'upgraded'
  }
  await prepareLocalWorktreeRootForRepo(watch.store, upgraded)
  invalidateAuthorizedRootsCache()
  if (watch.disposed) {
    return 'upgraded'
  }
  // Reuse mutation notifications for paired clients and newly eligible base/common-dir watchers (#11994).
  notifyReposChanged(watch.mainWindow)
  notifyWorktreesChanged(watch.mainWindow, repoId)
  return 'upgraded'
}

async function pollOnce(watch: UpgradeWatch): Promise<void> {
  // Closed macOS windows leave the app running; idle rather than probing Git during recreation.
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
    if (watch.disposed) {
      return
    }
    if (signature === null || rejectedMarkers.get(key) === signature) {
      continue
    }
    const result = await upgradeFolderRepo(watch, repo.id)
    if (watch.disposed) {
      return
    }
    if (result === 'rejected') {
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

/** Poll one .git stat per local folder project, park when hidden, and replace window ownership on reattachment. */
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
    // Avoid store reads on attach; the first tick resolves the appropriate cadence.
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
