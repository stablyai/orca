import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import type { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'

type RemoteLayoutSnapshotRuntime = Pick<StoreRuntimeState, 'state' | 'dirtyProfileStateDomains'>

/** Display-only cache: coalesce updates instead of rewriting the whole map on every save. */
export const REMOTE_LAYOUT_SNAPSHOT_SAVE_INTERVAL_MS = 5 * 60_000

const remoteLayoutSnapshotPersistenceContext = Symbol('RemoteLayoutSnapshotPersistence')
type RemoteLayoutSnapshotPersistenceContext = {
  runtime: RemoteLayoutSnapshotRuntime
  scheduling: WriteSchedulingOperations
  saveTimer: ReturnType<typeof setTimeout> | null
}

export class RemoteLayoutSnapshotPersistence {
  readonly [remoteLayoutSnapshotPersistenceContext]: RemoteLayoutSnapshotPersistenceContext

  constructor(runtime: RemoteLayoutSnapshotRuntime, scheduling: WriteSchedulingOperations) {
    this[remoteLayoutSnapshotPersistenceContext] = { runtime, scheduling, saveTimer: null }
  }

  getRemoteLayoutSnapshot(environmentId: string): RemoteLayoutSnapshot | undefined {
    return this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots?.[
      environmentId
    ]
  }

  getRemoteLayoutSnapshots(): Record<string, RemoteLayoutSnapshot> {
    const stored =
      this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots ?? {}
    // Drop legacy receivedAt/serverRuntimeId fields when returning snapshots.
    return Object.fromEntries(
      Object.entries(stored).map(([environmentId, { workspaces }]) => [
        environmentId,
        { workspaces }
      ])
    )
  }

  /**
   * Recorder-only writes. A removed server is forgotten immediately; layout and title updates are
   * a display-only cache, saved at most once per interval and by the final full checkpoint at quit.
   */
  setRemoteLayoutSnapshot(environmentId: string, snapshot: RemoteLayoutSnapshot | null): void {
    const context = this[remoteLayoutSnapshotPersistenceContext]
    const { runtime, scheduling } = context
    const { [environmentId]: previous, ...others } = runtime.state.remoteLayoutSnapshots ?? {}
    if (snapshot === null && previous === undefined) {
      return
    }
    runtime.state.remoteLayoutSnapshots = snapshot
      ? { ...others, [environmentId]: snapshot }
      : others
    if (snapshot === null) {
      // Save only this domain without waking workspace-session listeners.
      scheduleSave(scheduling, ['remoteLayoutSnapshots'])
      return
    }
    if (context.saveTimer) {
      return
    }
    context.saveTimer = setTimeout(() => {
      context.saveTimer = null
      scheduleSave(scheduling, ['remoteLayoutSnapshots'])
    }, REMOTE_LAYOUT_SNAPSHOT_SAVE_INTERVAL_MS)
    // Quit's full checkpoint persists the latest snapshot; this timer must not keep the app alive.
    context.saveTimer.unref?.()
  }
}
