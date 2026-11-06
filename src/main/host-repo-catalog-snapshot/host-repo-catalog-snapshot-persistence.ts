import type { HostRepoCatalogSnapshot } from '../../shared/host-repo-catalog-snapshot'
import type { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'

type HostRepoCatalogSnapshotRuntime = Pick<StoreRuntimeState, 'state'>

const hostRepoCatalogSnapshotPersistenceContext = Symbol('HostRepoCatalogSnapshotPersistence')
type HostRepoCatalogSnapshotPersistenceContext = {
  runtime: HostRepoCatalogSnapshotRuntime
  scheduling: WriteSchedulingOperations
}

export class HostRepoCatalogSnapshotPersistence {
  readonly [hostRepoCatalogSnapshotPersistenceContext]: HostRepoCatalogSnapshotPersistenceContext

  constructor(runtime: HostRepoCatalogSnapshotRuntime, scheduling: WriteSchedulingOperations) {
    this[hostRepoCatalogSnapshotPersistenceContext] = { runtime, scheduling }
  }

  getHostRepoCatalogSnapshots(): Record<string, HostRepoCatalogSnapshot> {
    return (
      this[hostRepoCatalogSnapshotPersistenceContext].runtime.state.hostRepoCatalogSnapshots ?? {}
    )
  }

  /** Null forgets the host. Saves only on change: every catalog refresh lands here. */
  setHostRepoCatalogSnapshot(
    environmentId: string,
    snapshot: HostRepoCatalogSnapshot | null
  ): void {
    const { runtime, scheduling } = this[hostRepoCatalogSnapshotPersistenceContext]
    const { [environmentId]: previous, ...others } = runtime.state.hostRepoCatalogSnapshots ?? {}
    const unchanged =
      snapshot === null
        ? previous === undefined
        : previous !== undefined && JSON.stringify(previous) === JSON.stringify(snapshot)
    if (unchanged) {
      return
    }
    runtime.state.hostRepoCatalogSnapshots = snapshot
      ? { ...others, [environmentId]: snapshot }
      : others
    scheduleSave(scheduling, ['hostRepoCatalogSnapshots'])
  }
}
