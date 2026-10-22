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

  /** Every server's snapshot, for `layout.getRemoteSnapshots`. */
  getRemoteLayoutSnapshots(): Record<string, RemoteLayoutSnapshot> {
    const stored =
      this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots ?? {}
    // Rebuilt so fields older builds stored (receivedAt, serverRuntimeId) are not handed on.
    return Object.fromEntries(
      Object.entries(stored).map(([environmentId, { workspaces }]) => [
        environmentId,
        { workspaces }
      ])
    )
  }

  /**
   * Only the recorder calls this (ratchet in remote-layout-snapshot-recorder.test.ts). `later`
   * marks the domain dirty without arming the save timer, so it rides the next save or quit flush.
   */
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
    // Named so the save writes only this domain and wakes no workspace-session listener.
    scheduleSave(scheduling, ['remoteLayoutSnapshots'])
  }
}
