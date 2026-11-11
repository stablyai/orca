// One workspace's sync while its sandbox runs: a full pass on start (and after anything that may
// have missed changes: reconnects, watch overflow, this computer waking), then the cloud's file
// watch drives small incremental passes. One-way: cloud → this computer. Copies are written
// read-only; a copy someone changed here anyway is left alone until the cloud changes it.
import { mkdir } from 'node:fs/promises'
import type { CloudSyncState } from '../../shared/cloud-sync/cloud-sync-contract'
import {
  downloadCopies,
  localStatAt,
  removeCopies,
  summarizeCopies
} from './cloud-sync-local-writes'
import { isContextPath, isSafeSyncPath } from './cloud-sync-paths'
import {
  emptySyncState,
  limitsFor,
  limitsInfo,
  planSync,
  type LocalStat,
  type RemoteEntry
} from './cloud-sync-plan'
import {
  filterIncluded,
  isWaitingError,
  listScope,
  resolveCloudWorktree,
  statFiles,
  type SyncCall,
  type SyncScope
} from './cloud-sync-remote'
import type { CloudSyncChoice, CloudSyncIndex, CloudSyncStore } from './cloud-sync-store'
import {
  createChangeBatcher,
  readWatchEvent,
  type WatchSubscribe,
  type WatchSubscription
} from './cloud-sync-watch'

export type { WatchSubscribe, WatchSubscription }

/**
 * Safety net for anything the watch missed. The VM's watcher can miss a directory created along
 * with its parent (`mkdir -p .context/shots`), so small folders are re-checked often (a few
 * calls each) and large mirrors less often: 30 ms per file, between 30 s and 10 min, and never
 * more than 5% of the time (a slow pass, e.g. on an image without files.statMany, waits longer).
 */
const SAFETY_TICK_MS = 30_000
export function safetyIntervalMs(files: number, lastPassMs = 0): number {
  return Math.min(10 * 60_000, Math.max(SAFETY_TICK_MS, files * 30, lastPassMs * 20))
}
const WATCH_RETRY_MIN_MS = 5_000
const WATCH_RETRY_MAX_MS = 5 * 60_000

export type CloudSyncSessionDeps = {
  workspaceId: string
  folder: string
  projectRoot: string | null
  call: SyncCall
  subscribeWatch: WatchSubscribe
  store: CloudSyncStore
  choice: CloudSyncChoice
  emit: (state: CloudSyncState) => void
  log?: (line: string) => void
  now?: () => number
}

export function createCloudSyncSession(deps: CloudSyncSessionDeps) {
  const now = deps.now ?? Date.now
  const log = (line: string): void => deps.log?.(`[cloud-sync] ${deps.workspaceId}: ${line}`)
  let choice = deps.choice
  let stopped = false
  let worktree: { selector: string; root: string } | null = null
  let index: CloudSyncIndex | null = null
  let chain: Promise<void> = Promise.resolve()
  let fullPassQueued = false
  let watch: WatchSubscription | null = null
  let watchRetryMs = WATCH_RETRY_MIN_MS
  let watchRetryTimer: ReturnType<typeof setTimeout> | null = null
  let safetyTimer: ReturnType<typeof setInterval> | null = null
  let lastFullPassAt = 0
  let lastFullPassMs = 0
  const abort = new AbortController()
  let state: CloudSyncState = emptySyncState(deps.workspaceId, deps.folder, choice, 'starting')
  const changes = createChangeBatcher({
    onPaths: (paths) => void enqueue(() => incrementalPass(paths)),
    onRescan: () => void requestFullPass(),
    now
  })

  const publish = (patch: Partial<CloudSyncState>): void => {
    state = { ...state, ...patch, choice, limits: limitsInfo(choice) }
    deps.emit(state)
  }

  const scope = (): SyncScope => (choice.mirror ? 'workspace' : 'context')

  async function loadIndex(): Promise<CloudSyncIndex> {
    index ??= await deps.store.readIndex(deps.workspaceId, deps.folder)
    if (index.lastSyncedAt !== null && state.lastSyncedAt === null) {
      publish({ lastSyncedAt: index.lastSyncedAt })
    }
    return index
  }

  async function ensureWorktree(): Promise<{ selector: string; root: string }> {
    worktree ??= await resolveCloudWorktree(deps.call, deps.workspaceId, deps.projectRoot)
    return worktree
  }

  /** Runs passes one at a time. */
  function enqueue(run: () => Promise<void>): Promise<void> {
    chain = chain.then(async () => {
      if (stopped) {
        return
      }
      try {
        await run()
      } catch (error) {
        if (stopped) {
          return
        }
        if (isWaitingError(error)) {
          // Asleep or waking: not a failure; the next wake starts a fresh session.
          publish({ phase: 'waiting', progress: null, error: null })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        log(message)
        publish({ phase: 'error', progress: null, error: message.slice(0, 300) })
      }
    })
    return chain
  }

  /** A full pass requested while one is queued collapses into it. */
  function requestFullPass(): Promise<void> {
    if (fullPassQueued) {
      return chain
    }
    fullPassQueued = true
    return enqueue(async () => {
      fullPassQueued = false
      changes.clear()
      await fullPass()
    })
  }

  async function fullPass(): Promise<void> {
    lastFullPassAt = now()
    const { selector } = await ensureWorktree()
    const current = await loadIndex()
    const limits = limitsFor(choice)
    if (state.lastSyncedAt === null) {
      publish({ phase: 'starting', error: null })
    }
    const listed = await listScope(deps.call, selector, scope(), limits.maxFiles, abort.signal)
    const remote = await statFiles(deps.call, selector, listed.paths, abort.signal)
    const paths = new Set([...remote.keys(), ...Object.keys(current.entries)])
    // Manifest cost only (listing + stat), not the copying a first pass does.
    lastFullPassMs = now() - lastFullPassAt
    await apply({ remote, paths, scoped: null, truncated: listed.truncated ? 1 : 0 })
  }

  async function incrementalPass(paths: string[]): Promise<void> {
    const { selector } = await ensureWorktree()
    await loadIndex()
    const included = await filterIncluded(deps.call, selector, scope(), paths, abort.signal)
    const remote = await statFiles(deps.call, selector, [...included], abort.signal)
    await apply({ remote, paths: new Set(paths), scoped: new Set(paths), truncated: 0 })
  }

  async function apply(input: {
    remote: Map<string, RemoteEntry>
    paths: Set<string>
    scoped: Set<string> | null
    truncated: number
  }): Promise<void> {
    const current = index!
    const limits = limitsFor(choice)
    await mkdir(deps.folder, { recursive: true })
    const local = new Map<string, LocalStat>()
    for (const path of input.paths) {
      if (isSafeSyncPath(path)) {
        local.set(path, await localStatAt(deps.folder, path))
      }
    }
    // Paths that left scope (mirror turned off) are removed like cloud deletions.
    const remote = new Map(
      [...input.remote].filter(
        ([path]) => isSafeSyncPath(path) && (choice.mirror || isContextPath(path))
      )
    )
    const plan = planSync({
      remote,
      index: current.entries,
      local,
      limits,
      ...(input.scoped ? { scope: input.scoped } : {})
    })
    await removeCopies(deps.folder, plan.remove, current.entries)
    if (plan.download.length > 0) {
      const { selector } = await ensureWorktree()
      await downloadCopies({
        call: deps.call,
        selector,
        folder: deps.folder,
        paths: plan.download,
        remote,
        entries: current.entries,
        maxFileBytes: limits.maxFileBytes,
        signal: abort.signal,
        onProgress: (done, total) => publish({ phase: 'copying', progress: { done, total } }),
        checkpoint: () => deps.store.writeIndex(deps.workspaceId, current),
        log
      })
    }
    const { files, bytes, edited } = await summarizeCopies(deps.folder, current.entries, {
      local,
      scoped: input.scoped,
      downloaded: new Set(plan.download)
    })
    current.lastSyncedAt = now()
    await deps.store.writeIndex(deps.workspaceId, current)
    const full = input.scoped === null
    publish({
      phase: 'synced',
      progress: null,
      files,
      bytes,
      lastSyncedAt: current.lastSyncedAt,
      // An incremental pass only re-checks its own paths; the last full pass's counts stand.
      editedHere: full ? edited : Math.max(state.editedHere, edited),
      skippedLarge: full ? plan.skippedLarge : state.skippedLarge + plan.skippedLarge,
      overLimit: full ? plan.overLimit + input.truncated : state.overLimit,
      error: null
    })
  }

  function onWatchEvent(event: unknown): void {
    if (!worktree) {
      return
    }
    const batch = readWatchEvent(event, worktree.root, choice.mirror)
    if (batch.kind === 'ready') {
      watchRetryMs = WATCH_RETRY_MIN_MS
    } else if (batch.kind === 'rescan') {
      changes.rescan()
    } else if (batch.kind === 'paths') {
      changes.add(batch.paths)
    }
  }

  async function openWatch(): Promise<void> {
    if (stopped || watch) {
      return
    }
    try {
      const { selector } = await ensureWorktree()
      const opened = await deps.subscribeWatch(selector, {
        onEvent: onWatchEvent,
        onClose: () => {
          watch = null
          scheduleWatchRetry()
        }
      })
      if (stopped) {
        opened.close()
        return
      }
      watch = opened
    } catch (error) {
      log(`watch failed: ${error instanceof Error ? error.message : String(error)}`)
      scheduleWatchRetry()
    }
  }

  function scheduleWatchRetry(): void {
    if (stopped || watchRetryTimer) {
      return
    }
    // Backs off so an unreachable sandbox never turns into a tight loop.
    const delay = watchRetryMs
    watchRetryMs = Math.min(WATCH_RETRY_MAX_MS, watchRetryMs * 2)
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = null
      // Changes made while the watch was down are only found by a full pass.
      void requestFullPass().then(openWatch)
    }, delay)
    watchRetryTimer.unref?.()
  }

  return {
    async start(): Promise<void> {
      publish({ phase: 'starting' })
      await loadIndex()
      await requestFullPass()
      await openWatch()
      safetyTimer = setInterval(() => {
        if (now() - lastFullPassAt >= safetyIntervalMs(state.files, lastFullPassMs)) {
          void requestFullPass()
        }
      }, SAFETY_TICK_MS)
      safetyTimer.unref?.()
    },
    /** This computer woke, or the connection came back: anything may have changed meanwhile. */
    resync(): Promise<void> {
      if (!watch) {
        void openWatch()
      }
      return requestFullPass()
    },
    setChoice(next: CloudSyncChoice): Promise<void> {
      choice = next
      publish({})
      return requestFullPass()
    },
    /** Stops syncing; the files stay (asleep). */
    stop(): Promise<void> {
      stopped = true
      abort.abort()
      watch?.close()
      watch = null
      changes.dispose()
      if (watchRetryTimer) {
        clearTimeout(watchRetryTimer)
      }
      if (safetyTimer) {
        clearInterval(safetyTimer)
      }
      watchRetryTimer = null
      safetyTimer = null
      return chain
    }
  }
}

export type CloudSyncSession = ReturnType<typeof createCloudSyncSession>
