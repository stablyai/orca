import type {
  RemoteLayoutSnapshot,
  RemoteLayoutSnapshotWorkspace
} from '../../shared/remote-layout-snapshot'
import type { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'

type RemoteLayoutSnapshotRuntime = Pick<StoreRuntimeState, 'state' | 'dirtyProfileStateDomains'>

const remoteLayoutSnapshotPersistenceContext = Symbol('RemoteLayoutSnapshotPersistence')
type RemoteLayoutSnapshotPersistenceContext = {
  runtime: RemoteLayoutSnapshotRuntime
  scheduling: WriteSchedulingOperations
}

function writeSnapshotEntry<T>(entries: Record<string, T>, id: string, value: T): void {
  // Admitted string identities must remain own keys even when named __proto__.
  Object.defineProperty(entries, id, {
    value,
    configurable: true,
    enumerable: true,
    writable: true
  })
}

function saveRemoteLayoutSnapshots(
  { runtime, scheduling }: RemoteLayoutSnapshotPersistenceContext,
  save: 'now' | 'later'
): void {
  if (save === 'later') {
    runtime.dirtyProfileStateDomains?.add('remoteLayoutSnapshots')
    return
  }
  // Save only this domain without waking workspace-session listeners.
  scheduleSave(scheduling, ['remoteLayoutSnapshots'])
}

export class RemoteLayoutSnapshotPersistence {
  readonly [remoteLayoutSnapshotPersistenceContext]: RemoteLayoutSnapshotPersistenceContext

  constructor(runtime: RemoteLayoutSnapshotRuntime, scheduling: WriteSchedulingOperations) {
    this[remoteLayoutSnapshotPersistenceContext] = { runtime, scheduling }
  }

  /** Recorder-only lookup; workspace values are replaced, never mutated. */
  getRemoteLayoutSnapshotWorkspace(
    environmentId: string,
    worktreeId: string
  ): RemoteLayoutSnapshotWorkspace | undefined {
    const snapshots =
      this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots
    const snapshot =
      snapshots && Object.hasOwn(snapshots, environmentId) ? snapshots[environmentId] : undefined
    return snapshot && Object.hasOwn(snapshot.workspaces, worktreeId)
      ? snapshot.workspaces[worktreeId]
      : undefined
  }

  getRemoteLayoutSnapshots(): Record<string, RemoteLayoutSnapshot> {
    const stored =
      this[remoteLayoutSnapshotPersistenceContext].runtime.state.remoteLayoutSnapshots ?? {}
    // Drop legacy receivedAt/serverRuntimeId fields when returning snapshots.
    return Object.fromEntries(
      Object.entries(stored).map(([environmentId, { workspaces }]) => [
        environmentId,
        { workspaces: structuredClone(workspaces) }
      ])
    )
  }

  /** Recorder-only writes; later marks dirty without a timer and persists with the next save/quit flush. */
  setRemoteLayoutSnapshot(
    environmentId: string,
    snapshot: RemoteLayoutSnapshot | null,
    save: 'now' | 'later'
  ): void {
    const context = this[remoteLayoutSnapshotPersistenceContext]
    const snapshots = (context.runtime.state.remoteLayoutSnapshots ??= {})
    if (snapshot === null && !Object.hasOwn(snapshots, environmentId)) {
      return
    }
    if (snapshot) {
      writeSnapshotEntry(snapshots, environmentId, snapshot)
    } else {
      delete snapshots[environmentId]
    }
    saveRemoteLayoutSnapshots(context, save)
  }

  setRemoteLayoutSnapshotWorkspace(
    environmentId: string,
    worktreeId: string,
    workspace: RemoteLayoutSnapshotWorkspace | null,
    save: 'now' | 'later'
  ): void {
    const context = this[remoteLayoutSnapshotPersistenceContext]
    const snapshots = (context.runtime.state.remoteLayoutSnapshots ??= {})
    const workspaces = Object.hasOwn(snapshots, environmentId)
      ? snapshots[environmentId].workspaces
      : {}
    if (workspace) {
      writeSnapshotEntry(workspaces, worktreeId, workspace)
    } else {
      delete workspaces[worktreeId]
    }
    writeSnapshotEntry(snapshots, environmentId, { workspaces })
    saveRemoteLayoutSnapshots(context, save)
  }
}
