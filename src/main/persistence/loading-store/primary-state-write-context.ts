import type { BackupRecoveryRotationOperations } from './backup-recovery-rotation'
import type { PrimaryStateWriteOperationsRuntime } from './primary-state-write-runtime'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

export type PrimaryStateWriteOperationsContext = {
  runtime: PrimaryStateWriteOperationsRuntime
  serialization: StateSerializationSecretHandlingOperations
  backups: BackupRecoveryRotationOperations
  queuedSnapshot?: {
    completion: Promise<void>
    capture: { skipIfClean: boolean; pendingSnapshotFileWork: Promise<void> | null }
  }
}
