import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import type { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'

type RemoteLayoutSnapshotRuntime = Pick<StoreRuntimeState, 'state' | 'dirtyProfileStateDomains'>

const remoteLayoutSnapshotPersistenceContext = Symbol('RemoteLayoutSnapshotPersistence')
type RemoteLayoutSnapshotPersistenceContext = {
  runtime: RemoteLayoutSnapshotRuntime
  scheduling: WriteSchedulingOperations
}

export class RemoteLayoutSnapshotPersistence {
  readonly [remoteLayoutSnapshotPersistenceContext]: RemoteLayoutSnapshotPersistenceContext

  constructor(runtime: RemoteLayoutSnapshotRuntime, scheduling: WriteSchedulingOperations) {
    this[remoteLayoutSnapshotPersistenceContext] = { runtime, scheduling }
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

  /** Recorder-only writes; later marks dirty without a timer and persists with the next save/quit flush. */
  setRemoteLayoutSnapshot(
    environmentId: string,
    snapshot: RemoteLayoutSnapshot | null,
    save: 'now' | 'later'
  ): void {
    const { runtime, scheduling } = this[remoteLayoutSnapshotPersistenceContext]
    const { [environmentId]: previous, ...others } = runtime.state.remoteLayoutSnapshots ?? {}
    if (snapshot === null && previous === undefined) {
      return
    }
    runtime.state.remoteLayoutSnapshots = snapshot
      ? { ...others, [environmentId]: snapshot }
      : others
    if (save === 'later') {
      runtime.dirtyProfileStateDomains?.add('remoteLayoutSnapshots')
      return
    }
    // Save only this domain without waking workspace-session listeners.
    scheduleSave(scheduling, ['remoteLayoutSnapshots'])
  }
}
