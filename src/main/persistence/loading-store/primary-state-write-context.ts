import type { PrimaryStateWriteOperationsRuntime } from './primary-state-write-runtime'
import type { StateSerializationSecretHandlingOperations } from './state-serialization-secret-handling'

export type PrimaryStateWriteOperationsContext = {
  runtime: PrimaryStateWriteOperationsRuntime
  serialization: StateSerializationSecretHandlingOperations
  queuedSnapshot?: {
    completion: Promise<void>
    capture: {
      skipIfClean: boolean
      fullCheckpoint: boolean
      pendingSnapshotFileWork: Promise<void> | null
    }
  }
}
