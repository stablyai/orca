import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurableIfCurrent
} from '../../durable-file-write'
import {
  getWorkspaceSessionPartitionFile,
  PARTITION_SCHEMA_VERSION,
  removePartitionFilesSync,
  rotateBackups,
  type WorkspaceSessionPartitionEnvelope,
  writePartitionSync,
  type LoadResolution,
  type WorkspaceSessionPartitionWriteTrigger
} from './workspace-session-sidecar-files'
import { WorkspaceSessionSidecarState } from './workspace-session-sidecar-state'

export {
  getWorkspaceSessionPartitionFile,
  workspaceSessionHash
} from './workspace-session-sidecar-files'
export type {
  WorkspaceSessionPartitionTrace,
  WorkspaceSessionPartitionWriteTrigger,
  WorkspaceSessionSidecarOptions
} from './workspace-session-sidecar-files'

export class WorkspaceSessionSidecarStore extends WorkspaceSessionSidecarState {
  flushSync(trigger: WorkspaceSessionPartitionWriteTrigger = 'flush'): void {
    if (this.frozen) {
      throw new Error('Cannot flush workspace sessions while persistence is finalized')
    }
    this.clearWriteTimer()
    for (const hostId of this.dirty.keys()) {
      const session = this.sessions.get(hostId)
      if (!session) {
        continue
      }
      const generation = this.generations.get(hostId) ?? 0
      const dirty = this.dirty.get(hostId)!
      const effectiveTrigger = dirty.trigger === 'migration' ? 'migration' : trigger
      const startedAt = performance.now()
      let partitionBytes: number
      try {
        partitionBytes = writePartitionSync(
          this.dataFile,
          {
            schemaVersion: PARTITION_SCHEMA_VERSION,
            hostId,
            writeGeneration: generation,
            writtenAt: this.now(),
            lastSynchronizedCoreHash: this.synchronizedCoreHashes.get(hostId),
            session
          },
          this.serialize
        )
        this.noteWriteSucceeded(hostId)
      } catch (error) {
        this.noteWriteFailed(hostId)
        throw error
      }
      this.durableGenerations.set(hostId, generation)
      if (this.generations.get(hostId) === generation) {
        this.dirty.delete(hostId)
      }
      this.onTrace?.({
        hostId,
        partitionBytes,
        durationMs: performance.now() - startedAt,
        trigger: effectiveTrigger,
        writeGeneration: generation,
        committed: true
      })
    }
  }

  async flushPending(
    options: {
      signal?: AbortSignal
      drainToStableGeneration?: boolean
      trigger?: WorkspaceSessionPartitionWriteTrigger
    } = {}
  ): Promise<void> {
    if (this.frozen) {
      throw new Error('Cannot flush workspace sessions while persistence is finalized')
    }
    this.clearWriteTimer()
    const drain = options.drainToStableGeneration ?? true
    const required = new Map(
      [...this.dirty.keys()].map((hostId) => [hostId, this.generations.get(hostId) ?? 0])
    )
    let transientFailures = 0
    for (;;) {
      if (options.signal?.aborted) {
        throw new Error('Workspace session flush aborted')
      }
      const hosts = [...this.dirty.keys()].filter((hostId) => {
        if (drain) {
          return true
        }
        return (this.durableGenerations.get(hostId) ?? -1) < (required.get(hostId) ?? -1)
      })
      if (hosts.length === 0) {
        const pending = [...this.pendingWrites.values()]
        if (pending.length === 0) {
          return
        }
        await Promise.all(pending)
        continue
      }
      try {
        await Promise.all(
          hosts.map((hostId) => this.enqueueHostWrite(hostId, options.trigger, !drain))
        )
      } catch (error) {
        transientFailures++
        if (!drain || transientFailures > 5) {
          throw error
        }
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, Math.min(2_000, 100 * 2 ** (transientFailures - 1)))
        await promise
        continue
      }
      if (!drain) {
        let requirementsMet = true
        for (const [hostId, generation] of required) {
          if ((this.durableGenerations.get(hostId) ?? -1) < generation) {
            requirementsMet = false
            break
          }
        }
        if (requirementsMet) {
          return
        }
      }
    }
  }
  private enqueueHostWrite(
    hostId: ExecutionHostId,
    triggerOverride?: WorkspaceSessionPartitionWriteTrigger,
    allowSupersededCommit = false
  ): Promise<void> {
    const previous = this.pendingWrites.get(hostId) ?? Promise.resolve()
    const write = previous
      .then(async () => {
        if (this.frozen || !this.dirty.has(hostId)) {
          return
        }
        const session = this.sessions.get(hostId)
        if (!session) {
          return
        }
        const generation = this.generations.get(hostId) ?? 0
        const dirty = this.dirty.get(hostId)!
        const trigger =
          dirty.trigger === 'migration' ? 'migration' : (triggerOverride ?? dirty.trigger)
        const envelope: WorkspaceSessionPartitionEnvelope = {
          schemaVersion: PARTITION_SCHEMA_VERSION,
          hostId,
          writeGeneration: generation,
          writtenAt: this.now(),
          lastSynchronizedCoreHash: this.synchronizedCoreHashes.get(hostId),
          session
        }
        const startedAt = performance.now()
        const payload = this.serialize(envelope)
        const partitionBytes = Buffer.byteLength(payload)
        const partitionFile = getWorkspaceSessionPartitionFile(this.dataFile, hostId)
        await mkdir(dirname(partitionFile), { recursive: true })
        await removeStaleDurableWriteTempFiles(partitionFile)
        await rotateBackups(partitionFile, hostId)
        const committed = await writeFileDurableIfCurrent(
          durableWriteTempPath(partitionFile),
          partitionFile,
          payload,
          () =>
            !this.frozen &&
            (this.generations.get(hostId) === generation ||
              (allowSupersededCommit && (this.durableGenerations.get(hostId) ?? -1) < generation))
        )
        if (committed) {
          this.noteWriteSucceeded(hostId)
          this.durableGenerations.set(hostId, generation)
          if (this.generations.get(hostId) === generation) {
            this.dirty.delete(hostId)
          }
        }
        this.onTrace?.({
          hostId,
          partitionBytes,
          durationMs: performance.now() - startedAt,
          trigger,
          writeGeneration: generation,
          committed
        })
      })
      .catch((error: unknown) => {
        this.noteWriteFailed(hostId)
        throw error
      })
    const tracked = write.finally(() => {
      if (this.pendingWrites.get(hostId) === tracked) {
        this.pendingWrites.delete(hostId)
      }
    })
    this.pendingWrites.set(hostId, tracked)
    return tracked
  }

  reassignHostPartition(
    oldHostId: ExecutionHostId,
    newHostId: ExecutionHostId,
    session: WorkspaceSessionState | undefined
  ): void {
    if (this.frozen || oldHostId === newHostId) {
      return
    }
    const previousOldWrite = this.pendingWrites.get(oldHostId) ?? Promise.resolve()
    this.generations.set(oldHostId, (this.generations.get(oldHostId) ?? 0) + 1)
    this.sessions.delete(oldHostId)
    this.dirty.delete(oldHostId)
    this.synchronizedCoreHashes.delete(oldHostId)
    if (session) {
      this.markDirty(newHostId, session, 'replace')
      const generation = this.generations.get(newHostId) ?? 0
      const startedAt = performance.now()
      let partitionBytes: number
      try {
        partitionBytes = writePartitionSync(
          this.dataFile,
          {
            schemaVersion: PARTITION_SCHEMA_VERSION,
            hostId: newHostId,
            writeGeneration: generation,
            writtenAt: this.now(),
            lastSynchronizedCoreHash: this.synchronizedCoreHashes.get(newHostId),
            session
          },
          this.serialize
        )
        this.noteWriteSucceeded(newHostId)
      } catch (error) {
        this.noteWriteFailed(newHostId)
        throw error
      }
      this.durableGenerations.set(newHostId, generation)
      this.dirty.delete(newHostId)
      this.onTrace?.({
        hostId: newHostId,
        partitionBytes,
        durationMs: performance.now() - startedAt,
        trigger: 'replace',
        writeGeneration: generation,
        committed: true
      })
    }
    removePartitionFilesSync(this.dataFile, oldHostId)
    this.durableGenerations.delete(oldHostId)
    const cleanup = previousOldWrite.then(() => {
      removePartitionFilesSync(this.dataFile, oldHostId)
    })
    const tracked = cleanup.finally(() => {
      if (this.pendingWrites.get(oldHostId) === tracked) {
        this.pendingWrites.delete(oldHostId)
      }
    })
    this.pendingWrites.set(oldHostId, tracked)
  }

  async waitForPendingWrite(): Promise<void> {
    if (this.writeTimer) {
      await this.flushPending({ drainToStableGeneration: true })
    }
    await Promise.all(this.pendingWrites.values())
  }

  getDurableGenerationByHostId(): Partial<Record<ExecutionHostId, number>> {
    const generations: Partial<Record<ExecutionHostId, number>> = {}
    for (const hostId of this.sessions.keys()) {
      const generation = this.durableGenerations.get(hostId)
      if (generation !== undefined && generation >= 0) {
        generations[hostId] = generation
      }
    }
    return generations
  }
}

export function readWorkspaceSessionSidecarsForProfile(args: {
  dataFile: string
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  embeddedLocalPresent: boolean
  embeddedHostIds: ReadonlySet<ExecutionHostId>
  embeddedPayloadPresent: boolean
  embeddedGenerationByHostId?: Partial<Record<ExecutionHostId, number>>
  coreRestoredFromBackup?: boolean
  replacementPending?: boolean
}): LoadResolution {
  return new WorkspaceSessionSidecarStore(args.dataFile).resolveForLoad(args)
}

export { replaceWorkspaceSessionSidecarsSync } from './workspace-session-sidecar-profile'
