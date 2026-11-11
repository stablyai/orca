// Runs cloud → this computer sync for every Orca Cloud workspace this desktop runs. A session
// lives only while the sandbox runs (sync never wakes or holds a sandbox awake: orcad's idle
// verdict ignores connected clients). Asleep: the copy stays readable. Archived or deleted: sync
// stops and the copy this computer made is removed (files someone added here are left alone).
import { join } from 'node:path'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type {
  CloudSyncRemovalPreview,
  CloudSyncState,
  CloudSyncView
} from '../../shared/cloud-sync/cloud-sync-contract'
import {
  cloudRuntimesFrom,
  previewRemoval,
  removeLocalCopy,
  removeMirroredFiles,
  type CloudRuntime
} from './cloud-sync-local-copy'
import { CONTEXT_DIR, displayPath } from './cloud-sync-paths'
import { limitsInfo, type CloudSyncChoice } from './cloud-sync-plan'
import type { SyncCall } from './cloud-sync-remote'
import {
  createCloudSyncSession,
  type CloudSyncSession,
  type WatchSubscribe
} from './cloud-sync-session'
import type { CloudSyncStore } from './cloud-sync-store'

/** Archived elsewhere is only visible on the control plane; checked on this slow beat. */
const ARCHIVE_CHECK_MS = 10 * 60_000

export type CloudSyncServiceDeps = {
  store: CloudSyncStore
  listRuntimes: () => EphemeralVmRuntimeRecord[]
  callFor: (environmentId: string) => SyncCall
  watchFor: (environmentId: string) => WatchSubscribe
  /** Control plane: the workspace is archived (sync stops, the local copy goes). */
  isArchived: (workspaceId: string) => Promise<boolean>
  broadcast: (view: CloudSyncView) => void
  openPath: (path: string) => Promise<boolean>
  home?: string
  log?: (line: string) => void
}

function idleState(
  runtime: CloudRuntime,
  choice: CloudSyncChoice,
  previous: CloudSyncState | undefined
): CloudSyncState {
  return {
    workspaceId: runtime.workspaceId,
    choice,
    folder: runtime.folder,
    phase: !choice.context && !choice.mirror ? 'off' : 'waiting',
    files: previous?.files ?? 0,
    bytes: previous?.bytes ?? 0,
    progress: null,
    lastSyncedAt: previous?.lastSyncedAt ?? null,
    editedHere: previous?.editedHere ?? 0,
    skippedLarge: previous?.skippedLarge ?? 0,
    overLimit: previous?.overLimit ?? 0,
    limits: limitsInfo(choice),
    error: null
  }
}

export function createCloudSyncService(deps: CloudSyncServiceDeps) {
  const log = deps.log ?? ((line: string) => console.error(line))
  const sessions = new Map<string, { session: CloudSyncSession; environmentId: string }>()
  const states = new Map<string, CloudSyncState>()
  const known = new Set<string>()
  const archiveCheckedAt = new Map<string, number>()
  /** Copies already removed (archived or deleted); nothing to check or remove again. */
  const retired = new Set<string>()
  let reconciling: Promise<void> | null = null
  let again = false
  let disposed = false

  const viewOf = (state: CloudSyncState): CloudSyncView => {
    const openPath =
      state.choice.mirror || !state.choice.context ? state.folder : join(state.folder, CONTEXT_DIR)
    return { ...state, openPath, displayPath: displayPath(openPath, deps.home) }
  }

  const publish = (state: CloudSyncState): void => {
    states.set(state.workspaceId, state)
    deps.broadcast(viewOf(state))
  }

  const findRuntime = (workspaceId: string): CloudRuntime | undefined =>
    cloudRuntimesFrom(deps.listRuntimes(), deps.home).find(
      (candidate) => candidate.workspaceId === workspaceId
    )

  async function stopSession(workspaceId: string): Promise<void> {
    const entry = sessions.get(workspaceId)
    if (entry) {
      sessions.delete(workspaceId)
      await entry.session.stop()
    }
  }

  /** Archived (choices kept for an unarchive) or deleted (choices forgotten): the copy goes. */
  async function retire(runtime: CloudRuntime, reason: 'archived' | 'deleted'): Promise<void> {
    if (retired.has(runtime.workspaceId)) {
      return
    }
    retired.add(runtime.workspaceId)
    log(`[cloud-sync] ${runtime.workspaceId}: ${reason}; removing the local copy`)
    await stopSession(runtime.workspaceId)
    await removeLocalCopy(deps.store, runtime.workspaceId, runtime.folder)
    if (reason === 'deleted') {
      await deps.store.forgetChoice(runtime.workspaceId)
    }
    archiveCheckedAt.delete(runtime.workspaceId)
    publish(idleState(runtime, await deps.store.choice(runtime.workspaceId), undefined))
  }

  function startSession(runtime: CloudRuntime, choice: CloudSyncChoice): void {
    const session = createCloudSyncSession({
      workspaceId: runtime.workspaceId,
      folder: runtime.folder,
      projectRoot: runtime.projectRoot,
      call: deps.callFor(runtime.environmentId),
      subscribeWatch: deps.watchFor(runtime.environmentId),
      store: deps.store,
      choice,
      emit: (state) => {
        if (sessions.get(runtime.workspaceId)?.session === session) {
          publish(state)
        }
      },
      log
    })
    sessions.set(runtime.workspaceId, { session, environmentId: runtime.environmentId })
    void session.start()
  }

  async function reconcileIdle(runtime: CloudRuntime, choice: CloudSyncChoice): Promise<void> {
    await stopSession(runtime.workspaceId)
    const previous = states.get(runtime.workspaceId)
    const next = idleState(runtime, choice, previous)
    // The 60 s beat lands here for every idle workspace: tell the window only what changed.
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      publish(next)
    }
    const at = archiveCheckedAt.get(runtime.workspaceId)
    const due = at === undefined || Date.now() - at >= ARCHIVE_CHECK_MS
    if (!runtime.running && !retired.has(runtime.workspaceId) && due) {
      archiveCheckedAt.set(runtime.workspaceId, Date.now())
      if (await deps.isArchived(runtime.workspaceId).catch(() => false)) {
        await retire(runtime, 'archived')
      }
    }
  }

  async function reconcileOnce(): Promise<void> {
    const runtimes = cloudRuntimesFrom(deps.listRuntimes(), deps.home)
    const present = new Set(runtimes.map((runtime) => runtime.workspaceId))
    // A record that vanished without passing through cleanup: stop, but never delete on a guess
    // (a store that failed to read would look the same).
    for (const workspaceId of known) {
      if (!present.has(workspaceId)) {
        await stopSession(workspaceId)
        known.delete(workspaceId)
      }
    }
    for (const runtime of runtimes) {
      if (disposed) {
        return
      }
      known.add(runtime.workspaceId)
      if (runtime.gone) {
        await retire(runtime, 'deleted')
        continue
      }
      const choice = await deps.store.choice(runtime.workspaceId)
      if (!runtime.running || (!choice.context && !choice.mirror)) {
        await reconcileIdle(runtime, choice)
        continue
      }
      archiveCheckedAt.delete(runtime.workspaceId)
      // Unarchived and running again: it syncs afresh.
      retired.delete(runtime.workspaceId)
      const current = sessions.get(runtime.workspaceId)
      if (current?.environmentId !== runtime.environmentId) {
        await stopSession(runtime.workspaceId)
        startSession(runtime, choice)
      }
    }
  }

  /** Coalesces bursts of runtime-store changes into one pass at a time. */
  function reconcile(): Promise<void> {
    if (reconciling) {
      again = true
      return reconciling
    }
    reconciling = (async () => {
      try {
        do {
          again = false
          await reconcileOnce().catch((error: unknown) =>
            log(
              `[cloud-sync] reconcile failed: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        } while (again && !disposed)
      } finally {
        reconciling = null
      }
    })()
    return reconciling
  }

  async function viewFor(workspaceId: string): Promise<CloudSyncView | null> {
    const state = states.get(workspaceId)
    if (state) {
      return viewOf(state)
    }
    const runtime = findRuntime(workspaceId)
    if (!runtime) {
      return null
    }
    const index = await deps.store.readIndex(workspaceId, runtime.folder)
    const entries = Object.values(index.entries)
    const loaded = {
      ...idleState(runtime, await deps.store.choice(workspaceId), undefined),
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.ls, 0),
      lastSyncedAt: index.lastSyncedAt
    }
    states.set(workspaceId, loaded)
    return viewOf(loaded)
  }

  return {
    reconcile,
    /** orcad (re)connected for an environment: resync its workspace now. */
    noteConnected(environmentId: string): void {
      for (const entry of sessions.values()) {
        if (entry.environmentId === environmentId) {
          void entry.session.resync()
        }
      }
      void reconcile()
    },
    /** Archived from this computer: remove the copy now, not on the next control-plane check. */
    async noteArchived(workspaceId: string): Promise<void> {
      const runtime = findRuntime(workspaceId)
      if (runtime) {
        await retire(runtime, 'archived')
      }
    },
    /** This computer woke from sleep: connections may have dropped and changes been missed. */
    noteSystemResumed(): void {
      for (const entry of sessions.values()) {
        void entry.session.resync()
      }
      void reconcile()
    },
    getState: viewFor,
    async setChoice(
      workspaceId: string,
      patch: Partial<CloudSyncChoice>
    ): Promise<CloudSyncView | null> {
      const runtime = findRuntime(workspaceId)
      if (!runtime) {
        return null
      }
      const choice = await deps.store.setChoice(workspaceId, patch)
      const session = sessions.get(workspaceId)
      if (!choice.context && !choice.mirror) {
        await stopSession(workspaceId)
        await removeLocalCopy(deps.store, workspaceId, runtime.folder)
        states.delete(workspaceId)
      } else if (session) {
        void session.session.setChoice(choice)
      } else {
        if (!choice.mirror) {
          await removeMirroredFiles(deps.store, workspaceId, runtime.folder)
        }
        states.delete(workspaceId)
      }
      await reconcile()
      return viewFor(workspaceId)
    },
    async retry(workspaceId: string): Promise<void> {
      const entry = sessions.get(workspaceId)
      await (entry ? entry.session.resync() : reconcile())
    },
    async openFolder(workspaceId: string): Promise<{ ok: boolean }> {
      const view = await viewFor(workspaceId)
      if (!view || view.phase === 'off') {
        return { ok: false }
      }
      return { ok: await deps.openPath(view.openPath) }
    },
    async removalPreview(workspaceId: string): Promise<CloudSyncRemovalPreview> {
      const runtime = findRuntime(workspaceId)
      return runtime
        ? previewRemoval(deps.store, workspaceId, runtime.folder)
        : { hasLocalCopy: false, editedHere: 0 }
    },
    async dispose(): Promise<void> {
      disposed = true
      await Promise.all([...sessions.keys()].map((workspaceId) => stopSession(workspaceId)))
    }
  }
}

export type CloudSyncService = ReturnType<typeof createCloudSyncService>
