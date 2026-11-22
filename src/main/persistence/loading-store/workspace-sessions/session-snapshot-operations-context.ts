import type { StoreRuntimeState } from '../store-runtime-state'
import type { TerminalBindingRecoveryOperations } from '../terminal-bindings/terminal-binding-recovery'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'

export type SessionSnapshotOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'durableMutationPhase'
  | 'pendingSnapshotFileWork'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'state'
  | 'terminalScrollbackSnapshotStorage'
  | 'retainedScrollbackRefsByMigrationId'
  | 'writesFrozen'
>

export const sessionSnapshotOperationsContext = Symbol('SessionSnapshotOperations')
export type SessionSnapshotOperationsContext = {
  runtime: SessionSnapshotOperationsRuntime
  sessions: SessionHostPartitionOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  scheduling: WriteSchedulingOperations
}

export function getSessionSnapshotOperationsContext(owner: {
  readonly [sessionSnapshotOperationsContext]: SessionSnapshotOperationsContext
}): SessionSnapshotOperationsContext {
  return owner[sessionSnapshotOperationsContext]
}
