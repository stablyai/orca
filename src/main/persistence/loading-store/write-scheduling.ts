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

/** Undefined means any domain may have changed. */
export type StateWriteListener = (dirtyDomains: readonly string[] | undefined) => void

const SAVE_DEBOUNCE_MS = 1_000
const SAVE_MAX_WAIT_MS = 5_000

type WriteSchedulingOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'automationListProjectionCache'
  | 'dirtyProfileStateDomains'
  | 'firstPendingSaveAt'
  | 'pendingWrite'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'writeGeneration'
  | 'writeTimer'
  | 'writesFrozen'
  | 'workspaceSessionWriteListeners'
  | 'workspaceSessionOperationListeners'
  | 'stateWriteListeners'
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
}

export function scheduleSave(
  owner: WriteSchedulingOperations,
  dirtyDomains?: readonly string[],
  writtenHostId?: ExecutionHostId
): void {
  const { runtime, writes } = owner[writeSchedulingOperationsContext]
  notifyWorkspaceSessionWritten(runtime, dirtyDomains, writtenHostId)
  for (const listener of runtime.stateWriteListeners) {
    listener(dirtyDomains)
  }
  runtime.automationListProjectionCache = null
  const trackedDomains = runtime.dirtyProfileStateDomains
  if (dirtyDomains === undefined) {
    runtime.dirtyProfileStateDomains = null
  } else if (trackedDomains !== null) {
    for (const domain of dirtyDomains) {
      trackedDomains.add(domain)
    }
  }
  // A timer admitted after the final snapshot could outlive the awaited shutdown work.
  if (runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    return
  }
  runtime.writeGeneration += 1
  if (runtime.writesFrozen) {
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
