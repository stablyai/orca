import {
  readDeregisteredWorkspaceSurfaces,
  pruneDeregisteredTerminalSurfacesSync
} from './deregistered-surface-retirement'
import type { JournalPersistenceEffect } from '../../native-chat/agent-session-journal/journal-persistence-plan'
import {
  orphanSurfaceRetirements,
  assertOrphanRetirementsAccepted
} from '../../workspace-surfaces/surface-orphan-retirement'
import type {
  SurfaceJointTransaction,
  SurfaceJointResult
} from '../../workspace-surfaces/surface-joint-transaction'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  runTargetOf,
  type SurfaceRunTarget
} from '../../../shared/workspace-surfaces/surface-allocation'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'
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

const workspaceSurfaceCommandsContext = Symbol('WorkspaceSurfaceCommands')
type WorkspaceSurfaceCommandsContext = {
  runtime: StoreRuntimeState
  writes: PrimaryStateWriteOperations
}

/** Share snapshot ordering; publish only the profile owner's committed decision. */
export class WorkspaceSurfaceCommands {
  readonly [workspaceSurfaceCommandsContext]: WorkspaceSurfaceCommandsContext

  constructor(runtime: StoreRuntimeState, writes: PrimaryStateWriteOperations) {
    this[workspaceSurfaceCommandsContext] = { runtime, writes }
  }

  onWorkspaceSurfaceCommitted(listener: (result: SurfaceStorageResult) => void): () => void {
    const listeners = this[workspaceSurfaceCommandsContext].runtime.workspaceSurfaceCommitListeners
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  onProfilePersistenceFinalized(listener: () => void): () => void {
    const listeners =
      this[workspaceSurfaceCommandsContext].runtime.profilePersistenceFinalizedListeners
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  captureSurfaceExecutionScope() {
    const { runtime } = this[workspaceSurfaceCommandsContext]
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      throw new Error('Cannot execute against finalized profile persistence')
    }
    const scope = runtime.profileStateAuthority?.surfaceExecutionScope
    return scope ? { ...scope } : undefined
  }

  workspaceSurfacesInitialized(hostId: ExecutionHostId = 'local'): boolean {
    return (
      this[workspaceSurfaceCommandsContext].runtime.workspaceSurfaces?.initialized(hostId) === true
    )
  }

  /** Capture before the first launch await; absence cannot later become a successor's authority. */
  captureWorkspaceSurfaceRun(
    pane: { worktreeId: string; tabId: string; leafId: string },
    hostId: ExecutionHostId = 'local'
  ): SurfaceRunTarget | null | undefined {
    const reader = this[workspaceSurfaceCommandsContext].runtime.workspaceSurfaces
    if (!reader?.initialized(hostId)) {
      return undefined
    }
    const surface = reader
      .all(hostId)
      .find(
        (candidate) =>
          candidate.workspaceId === pane.worktreeId &&
          candidate.content?.kind === 'terminal' &&
          (candidate.hostTabId === pane.tabId || candidate.content.entityId === pane.tabId)
      )
    return surface ? runTargetOf(surface, pane.leafId) : null
  }

  /** Fresh synchronous/offline stores publish their defaults before any caller can edit content. */
  initializeWorkspaceSurfacesSync(hostId: ExecutionHostId = 'local'): void {
    const { runtime, writes } = this[workspaceSurfaceCommandsContext]
    if (this.workspaceSurfacesInitialized(hostId)) {
      return
    }
    const authority = runtime.profileStateAuthority
    if (!authority || authority.asynchronous || !authority.executeSurfaceCommand) {
      throw new Error('Synchronous surface startup requires its admitted profile owner')
    }
    writes.flushOrThrow()
    const before = structuredClone(readSurfaceRuntimeSession(runtime, hostId))
    const command: SurfaceStorageCommand = { type: 'initialize', hostId }
    const generation = runtime.writeGeneration
    const result = authority.executeSurfaceCommand(command)
    publishCommittedSurfaceCommand(runtime, hostId, command, before, generation, result)
  }

  /** Prepare exact targets after earlier writes; the owner commits all partitions together. */
  executeWorkspaceSurfaceTransaction(
    prepare: () => readonly SurfaceStorageMutation[],
    committed?: (results: readonly SurfaceStorageResult[]) => void
  ): Promise<SurfaceStorageResult[]> {
    const { runtime, writes } = this[workspaceSurfaceCommandsContext]
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return Promise.reject(new Error('Cannot mutate finalized profile persistence'))
    }
    return enqueuePrimaryStateOperation(writes, async () => {
      const authority = runtime.profileStateAuthority
      if (!authority?.executeSurfaceTransaction) {
        throw new Error('Workspace surface transactions require their profile storage owner')
      }
      await writeToDiskAsync(writes)
      const commands = prepare()
      if (commands.length === 0) {
        committed?.([])
        if (committed) {
          await writeToDiskAsync(writes)
        }
        return []
      }
      const before = commands.map((command) => {
        const hostId = normalizeExecutionHostId(command.hostId)
        if (!hostId) {
          throw new Error('Workspace surface command has an invalid host')
        }
        return { hostId, session: structuredClone(readSurfaceRuntimeSession(runtime, hostId)) }
      })
      const generation = runtime.writeGeneration
      const results = await authority.executeSurfaceTransaction(commands)
      const failures: unknown[] = []
      for (const [index, result] of results.entries()) {
        const captured = before[index]!
        try {
          publishCommittedSurfaceCommand(
            runtime,
            captured.hostId,
            commands[index]!,
            captured.session,
            generation,
            result
          )
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Committed surface publication failed')
      }
      committed?.(results)
      if (committed) {
        await writeToDiskAsync(writes)
      }
      return results
    })
  }

  readWorkspaceSurfaces(hostId: ExecutionHostId = 'local') {
    return this[workspaceSurfaceCommandsContext].runtime.workspaceSurfaces?.all(hostId) ?? []
  }

  readDeregisteredWorkspaceSurfaces() {
    return readDeregisteredWorkspaceSurfaces(this[workspaceSurfaceCommandsContext].runtime)
  }

  pruneDeregisteredTerminalSurfacesSync(): void {
    const { runtime, writes } = this[workspaceSurfaceCommandsContext]
    pruneDeregisteredTerminalSurfacesSync(runtime, writes)
  }

  async pruneDeregisteredTerminalSurfaces(): Promise<void> {
    const results = await this.executeWorkspaceSurfaceTransaction(() =>
      orphanSurfaceRetirements(
        this.readDeregisteredWorkspaceSurfaces().filter(
          (surface) => surface.content?.kind === 'terminal'
        )
      )
    )
    assertOrphanRetirementsAccepted(results)
  }

  /** The native lane is already held; profile snapshots and attached work share this profile queue. */
  executeWorkspaceSurfaceJournalUnit(
    transaction: SurfaceJointTransaction,
    effects: readonly JournalPersistenceEffect[],
    committed?: (
      result: SurfaceJointResult,
      publish: (notify?: (callback: () => void) => void) => void
    ) => Promise<void>,
    admit?: () => void,
    afterCommitted?: (result: SurfaceJointResult) => void
  ): Promise<SurfaceJointResult> {
    const { runtime, writes } = this[workspaceSurfaceCommandsContext]
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return Promise.reject(new Error('Cannot mutate finalized profile persistence'))
    }
    return enqueuePrimaryStateOperation(writes, async () => {
      const authority = runtime.profileStateAuthority
      if (!authority?.executeSurfaceJournalUnit) {
        throw new Error('Native membership requires its profile storage owner')
      }
      await writeToDiskAsync(writes)
      admit?.()
      const before = transaction.commands.map((command) => {
        const hostId = normalizeExecutionHostId(command.hostId)
        if (!hostId) {
          throw new Error('Workspace surface command has an invalid host')
        }
        return { hostId, session: structuredClone(readSurfaceRuntimeSession(runtime, hostId)) }
      })
      const generation = runtime.writeGeneration
      const result = await authority.executeSurfaceJournalUnit(transaction, effects)
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
    })
  }

  executeWorkspaceSurfaceCommand(command: SurfaceStorageCommand): Promise<SurfaceStorageResult> {
    const context = this[workspaceSurfaceCommandsContext]
    const { runtime, writes } = context
    if (runtime.writesFrozen || runtime.quitFlushStarted || runtime.profileMaintenancePending) {
      return Promise.reject(new Error('Cannot mutate finalized profile persistence'))
    }
    return enqueuePrimaryStateOperation(writes, async () => {
      const authority = runtime.profileStateAuthority
      if (!authority?.executeSurfaceCommand) {
        throw new Error('Workspace surface commands require their profile storage owner')
      }
      const hostId = normalizeExecutionHostId(command.hostId)
      if (!hostId) {
        throw new Error('Workspace surface command has an invalid host')
      }
      await writeToDiskAsync(writes)
      const before = structuredClone(readSurfaceRuntimeSession(runtime, hostId))
      const generation = runtime.writeGeneration
      const result = await authority.executeSurfaceCommand(command)
      publishCommittedSurfaceCommand(runtime, hostId, command, before, generation, result)
      return result
    })
  }
}
