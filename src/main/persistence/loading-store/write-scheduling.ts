import type { StoreRuntimeState } from './store-runtime-state'
import type { PrimaryStateWriteOperations } from './primary-state-writes'
import { enqueueWrite } from './primary-state-writes'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  notifyWorkspaceSessionWritten,
  type WorkspaceSessionOperationListener,
  type WorkspaceSessionWriteListener
} from './workspace-session-write-listeners'
import { ptyBindingGenerationOf } from './pty-binding-generations'
import type { PartitionEditorViews } from './layout-editor-views'
import type { ProfileSaveDomains } from '../profile-save-domains'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

/** Undefined means any domain may have changed. */
export type StateWriteListener = (dirtyDomains: readonly string[] | undefined) => void
/** One host's worktree metadata row before and after a write. */
export type WorktreeMetaWriteListener = (write: {
  worktreeId: string
  hostId: ExecutionHostId
  previous: WorktreeMeta | undefined
  next: WorktreeMeta
}) => void

const SAVE_DEBOUNCE_MS = 1_000
const SAVE_MAX_WAIT_MS = 5_000

type WriteSchedulingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'pendingAutomationRunsAfter'
  | 'dirtyProfileStateDomains'
  | 'firstPendingSaveAt'
  | 'lastWriteError'
  | 'pendingWrite'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
  | 'workspaceSessionWriteListeners'
  | 'workspaceSessionOperationListeners'
  | 'stateWriteListeners'
  | 'worktreeMetaWriteListeners'
  | 'workspaceMetadataCursor'
  | 'ptyBindingGenerations'
  | 'layoutEditorViews'
  | 'state'
>

const writeSchedulingOperationsContext = Symbol('WriteSchedulingOperations')
type WriteSchedulingOperationsContext = {
  runtime: WriteSchedulingOperationsRuntime
  writes: PrimaryStateWriteOperations
}

export class WriteSchedulingOperations {
  readonly [writeSchedulingOperationsContext]: WriteSchedulingOperationsContext

  constructor(runtime: WriteSchedulingOperationsRuntime, writes: PrimaryStateWriteOperations) {
    this[writeSchedulingOperationsContext] = { runtime, writes }
  }

  async waitForPendingWrite(): Promise<void> {
    const { runtime } = this[writeSchedulingOperationsContext]
    await Promise.all([runtime.pendingWrite, runtime.activeViewPreference.waitForPendingWrite()])
    if (runtime.lastWriteError != null) {
      throw runtime.lastWriteError
    }
  }

  /** Observe in-memory session writes; callbacks must not throw or block. */
  onWorkspaceSessionWritten(listener: WorkspaceSessionWriteListener): () => void {
    const { runtime } = this[writeSchedulingOperationsContext]
    runtime.workspaceSessionWriteListeners.add(listener)
    return () => {
      runtime.workspaceSessionWriteListeners.delete(listener)
    }
  }

  /** Main-owned layouts notify once after all declared partitions; callbacks must not throw or block. */
  onWorkspaceSessionOperationEnded(listener: WorkspaceSessionOperationListener): () => void {
    const { runtime } = this[writeSchedulingOperationsContext]
    runtime.workspaceSessionOperationListeners.add(listener)
    return () => {
      runtime.workspaceSessionOperationListeners.delete(listener)
    }
  }

  getPtyBindingGeneration(hostId: ExecutionHostId, leafId: string): number | undefined {
    return ptyBindingGenerationOf(this[writeSchedulingOperationsContext].runtime, hostId, leafId)
  }

  getLayoutEditorViews(hostId: ExecutionHostId): PartitionEditorViews | undefined {
    return this[writeSchedulingOperationsContext].runtime.layoutEditorViews.get(hostId)
  }

  /** Observe save-scheduling writes; callbacks must not throw or block. */
  onStateWritten(listener: StateWriteListener): () => void {
    const { runtime } = this[writeSchedulingOperationsContext]
    runtime.stateWriteListeners.add(listener)
    return () => {
      runtime.stateWriteListeners.delete(listener)
    }
  }

  /** The workspaceMetadata position a listing records when it reads metadata. */
  getWorkspaceMetadataCursor(): { epoch: string; seq: number } {
    const { epoch, seq } = this[writeSchedulingOperationsContext].runtime.workspaceMetadataCursor
    return { epoch, seq }
  }

  /** Advances the position for one published record; call in the same turn as its metadata write. */
  advanceWorkspaceMetadataCursor(): { epoch: string; seq: number } {
    const cursor = this[writeSchedulingOperationsContext].runtime.workspaceMetadataCursor
    cursor.seq += 1
    return { epoch: cursor.epoch, seq: cursor.seq }
  }

  /** Observe each host-qualified worktree metadata write; callbacks must not throw, block or write. */
  onWorktreeMetaWritten(listener: WorktreeMetaWriteListener): () => void {
    const { runtime } = this[writeSchedulingOperationsContext]
    runtime.worktreeMetaWriteListeners.add(listener)
    return () => {
      runtime.worktreeMetaWriteListeners.delete(listener)
    }
  }
}

/** Saves the rows of the domains a mutation changed. */
export function scheduleSave(
  owner: WriteSchedulingOperations,
  domains: ProfileSaveDomains,
  writtenHostId?: ExecutionHostId
): void {
  scheduleDomainSave(owner, domains, writtenHostId)
}

/** Startup load, migration and maintenance resume only: their changes span the profile. */
export function scheduleFullProfileSave(owner: WriteSchedulingOperations): void {
  scheduleDomainSave(owner, undefined)
}

function scheduleDomainSave(
  owner: WriteSchedulingOperations,
  dirtyDomains: readonly string[] | undefined,
  writtenHostId?: ExecutionHostId
): void {
  const { runtime, writes } = owner[writeSchedulingOperationsContext]
  notifyWorkspaceSessionWritten(runtime, dirtyDomains, writtenHostId)
  for (const listener of runtime.stateWriteListeners) {
    listener(dirtyDomains)
  }
  runtime.automationListProjectionCache = null
  // A run list replaced outside the run-delta path saves as a whole row; an older pending delta is stale.
  if (
    dirtyDomains?.includes('automationRuns') &&
    runtime.pendingAutomationRunsAfter !== runtime.state.automationRuns
  ) {
    runtime.pendingAutomationRunsAfter = undefined
  }
  const trackedDomains = runtime.dirtyProfileStateDomains
  if (dirtyDomains === undefined) {
    runtime.dirtyProfileStateDomains = null
  } else if (trackedDomains !== null) {
    for (const domain of dirtyDomains) {
      trackedDomains.add(domain)
    }
  }
  // A successful quit snapshot is the last write. A failed one is not disk-consistent.
  if (runtime.profileMaintenancePending) {
    return
  }
  if (runtime.quitFlushStarted && runtime.lastWriteError == null) {
    return
  }
  runtime.writeGeneration += 1
  if (runtime.writesFrozen) {
    return
  }
  if (runtime.quitFlushStarted) {
    if (runtime.writeTimer) {
      clearTimeout(runtime.writeTimer)
      runtime.writeTimer = null
    }
    runtime.firstPendingSaveAt = null
    void enqueueWrite(writes).catch(() => {})
    return
  }
  const now = Date.now()
  runtime.firstPendingSaveAt ??= now
  if (runtime.writeTimer) {
    clearTimeout(runtime.writeTimer)
  }
  const untilMaxWait = Math.max(0, runtime.firstPendingSaveAt + SAVE_MAX_WAIT_MS - now)
  const delay = Math.min(SAVE_DEBOUNCE_MS, untilMaxWait)
  runtime.writeTimer = setTimeout(() => {
    runtime.writeTimer = null
    runtime.firstPendingSaveAt = null
    void enqueueWrite(writes, { skipIfClean: true }).catch(() => {})
  }, delay)
}
