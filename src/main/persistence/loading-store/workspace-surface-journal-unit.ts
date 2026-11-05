import type { StoreRuntimeState } from './store-runtime-state'
import {
  enqueuePrimaryStateOperation,
  writeToDiskAsync,
  type PrimaryStateWriteOperations
} from './primary-state-writes'
import {
  publishCommittedSurfaceCommand,
  readSurfaceRuntimeSession
} from './surface-committed-publication'
import { releaseSurfaceAdmissions } from '../../workspace-surfaces/surface-admission-capture'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
import type {
  SurfaceJointTransaction,
  SurfaceJointResult
} from '../../workspace-surfaces/surface-joint-transaction'
import type { JournalPersistenceEffect } from '../../native-chat/agent-session-journal/journal-persistence-plan'

/** Hold the native lane while the common profile queue commits membership and journal work. */
export function executeWorkspaceSurfaceJournalUnit(
  runtime: StoreRuntimeState,
  writes: PrimaryStateWriteOperations,
  admission: {
    capture(command: SurfaceStorageCommand): void
    canExecute(command: SurfaceStorageMutation): Promise<boolean>
    invalidate(results: readonly SurfaceStorageResult[]): void
  },
  transaction: SurfaceJointTransaction,
  effects: readonly JournalPersistenceEffect[],
  committed?: (
    result: SurfaceJointResult,
    publish: (notify?: (callback: () => void) => void) => void
  ) => Promise<void>,
  admit?: () => void,
  afterCommitted?: (result: SurfaceJointResult) => void
): Promise<SurfaceJointResult> {
  if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
    return Promise.reject(new Error('Cannot mutate finalized profile persistence'))
  }
  try {
    for (const command of transaction.commands) {
      admission.capture(command)
    }
  } catch (error) {
    releaseSurfaceAdmissions(transaction.commands)
    return Promise.reject(error)
  }
  return enqueuePrimaryStateOperation(writes, async () => {
    const authority = runtime.profileStateAuthority
    if (!authority?.executeSurfaceJournalUnit) {
      throw new Error('Native membership requires its profile storage owner')
    }
    await writeToDiskAsync(writes)
    admit?.()
    for (const command of transaction.commands) {
      if (!(await admission.canExecute(command))) {
        throw new Error('surface_changed')
      }
    }
    const before = transaction.commands.map((command) => {
      const hostId = normalizeExecutionHostId(command.hostId)
      if (!hostId) {
        throw new Error('Workspace surface command has an invalid host')
      }
      return { hostId, session: structuredClone(readSurfaceRuntimeSession(runtime, hostId)) }
    })
    const generation = runtime.writeGeneration
    const result = await authority.executeSurfaceJournalUnit(transaction, effects)
    admission.invalidate(result.surfaces)
    const publish = (notify?: (callback: () => void) => void) => {
      const failures: unknown[] = []
      for (const [index, surface] of result.surfaces.entries()) {
        const captured = before[index]!
        try {
          publishCommittedSurfaceCommand(
            runtime,
            captured.hostId,
            transaction.commands[index]!,
            captured.session,
            generation,
            surface,
            notify
          )
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Committed native surface publication failed')
      }
    }
    if (committed) {
      await committed(result, publish)
    } else {
      publish()
    }
    afterCommitted?.(result)
    if (afterCommitted) {
      await writeToDiskAsync(writes)
    }
    return result
  }).finally(() => releaseSurfaceAdmissions(transaction.commands))
}
