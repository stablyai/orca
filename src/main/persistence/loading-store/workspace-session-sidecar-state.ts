// In-memory workspace-session partition state, migration resolution, and write scheduling.
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  removePartitionFilesSync,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_WAIT_MS,
  workspaceSessionHash,
  type DirtyPartition,
  type LoadResolution,
  type WorkspaceSessionPartitionTrace,
  type WorkspaceSessionPartitionWriteTrigger,
  type WorkspaceSessionSidecarOptions
} from './workspace-session-sidecar-files'
import {
  resolveWorkspaceSessionSidecarLoad,
  type WorkspaceSessionSidecarLoadArguments
} from './workspace-session-sidecar-load-resolution'

export abstract class WorkspaceSessionSidecarState {
  protected readonly dataFile: string
  protected readonly onTrace?: (trace: WorkspaceSessionPartitionTrace) => void
  protected readonly serialize: (value: unknown) => string
  protected readonly now: () => number
  protected readonly sessions = new Map<ExecutionHostId, WorkspaceSessionState>()
  protected readonly generations = new Map<ExecutionHostId, number>()
  protected readonly durableGenerations = new Map<ExecutionHostId, number>()
  protected readonly dirty = new Map<ExecutionHostId, DirtyPartition>()
  protected readonly pendingWrites = new Map<ExecutionHostId, Promise<void>>()
  protected readonly synchronizedCoreHashes = new Map<ExecutionHostId, string>()
  private embeddedPayloadPresent = false
  protected frozen = false
  private finalFlushStarted = false
  protected writeTimer: ReturnType<typeof setTimeout> | null = null
  private firstPendingSaveAt: number | null = null
  private readonly pendingPruneHostIds = new Set<ExecutionHostId>()
  private readonly retryAttempts = new Map<ExecutionHostId, number>()

  constructor(dataFile: string, options: WorkspaceSessionSidecarOptions = {}) {
    this.dataFile = dataFile
    this.onTrace = options.onTrace
    this.serialize = options.serialize ?? JSON.stringify
    this.now = options.now ?? Date.now
  }
  abstract flushSync(trigger?: WorkspaceSessionPartitionWriteTrigger): void

  abstract flushPending(options?: {
    signal?: AbortSignal
    drainToStableGeneration?: boolean
    trigger?: WorkspaceSessionPartitionWriteTrigger
  }): Promise<void>

  resolveForLoad(args: WorkspaceSessionSidecarLoadArguments): LoadResolution {
    this.embeddedPayloadPresent = args.embeddedPayloadPresent
    return resolveWorkspaceSessionSidecarLoad(
      {
        dataFile: this.dataFile,
        sessions: this.sessions,
        generations: this.generations,
        durableGenerations: this.durableGenerations,
        dirty: this.dirty,
        synchronizedCoreHashes: this.synchronizedCoreHashes,
        pendingPruneHostIds: this.pendingPruneHostIds
      },
      args
    )
  }

  initialize(
    workspaceSession: WorkspaceSessionState,
    workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>,
    normalizedHostIds: ReadonlySet<ExecutionHostId> = new Set()
  ): { coreCleanupReady: boolean; embeddedPayloadPresent: boolean } {
    this.sessions.set(LOCAL_EXECUTION_HOST_ID, workspaceSession)
    for (const [rawHostId, session] of Object.entries(workspaceSessionsByHostId ?? {})) {
      const hostId = normalizeExecutionHostId(rawHostId)
      if (hostId && hostId !== LOCAL_EXECUTION_HOST_ID && session) {
        this.sessions.set(hostId, session)
      }
    }
    for (const hostId of normalizedHostIds) {
      if (this.sessions.has(hostId)) {
        this.dirty.set(hostId, { trigger: 'migration', migration: false })
      }
    }
    for (const hostId of this.dirty.keys()) {
      this.bumpGeneration(hostId)
    }
    try {
      this.flushSync('migration')
    } catch (error) {
      console.error(
        '[persistence] Failed to migrate embedded workspace sessions to sidecars:',
        error
      )
    }
    if (!this.hasPendingMigration()) {
      for (const hostId of this.pendingPruneHostIds) {
        removePartitionFilesSync(this.dataFile, hostId)
      }
      this.pendingPruneHostIds.clear()
    }
    return {
      coreCleanupReady: !this.hasPendingMigration(),
      embeddedPayloadPresent: this.embeddedPayloadPresent
    }
  }

  markDirty(
    hostId: ExecutionHostId,
    session: WorkspaceSessionState,
    trigger: WorkspaceSessionPartitionWriteTrigger
  ): void {
    if (this.frozen || this.finalFlushStarted) {
      return
    }
    this.sessions.set(hostId, session)
    this.bumpGeneration(hostId)
    this.dirty.set(hostId, { trigger, migration: this.dirty.get(hostId)?.migration ?? false })
    this.scheduleWrite()
  }

  private bumpGeneration(hostId: ExecutionHostId): number {
    const generation = (this.generations.get(hostId) ?? 0) + 1
    this.generations.set(hostId, generation)
    return generation
  }

  protected scheduleWrite(delayMs = SAVE_DEBOUNCE_MS): void {
    if (this.frozen) {
      return
    }
    const now = this.now()
    this.firstPendingSaveAt ??= now
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
    }
    const untilMaxWait = Math.max(0, this.firstPendingSaveAt + SAVE_MAX_WAIT_MS - now)
    this.writeTimer = setTimeout(
      () => {
        this.writeTimer = null
        this.firstPendingSaveAt = null
        void this.flushPending({ drainToStableGeneration: false }).catch((error) => {
          console.error('[persistence] Failed to write workspace session partition:', error)
        })
      },
      Math.min(delayMs, untilMaxWait)
    )
  }
  protected noteWriteSucceeded(hostId: ExecutionHostId): void {
    this.retryAttempts.delete(hostId)
  }

  protected noteWriteFailed(hostId: ExecutionHostId): void {
    const attempt = (this.retryAttempts.get(hostId) ?? 0) + 1
    this.retryAttempts.set(hostId, attempt)
    if (attempt > 5 || this.frozen) {
      return
    }
    const hostJitter = [...hostId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 97
    this.scheduleWrite(Math.min(5_000, 100 * 2 ** (attempt - 1) + hostJitter))
  }

  protected clearWriteTimer(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.firstPendingSaveAt = null
  }

  private hasPendingMigration(): boolean {
    for (const dirty of this.dirty.values()) {
      if (dirty.migration) {
        return true
      }
    }
    return false
  }

  isCoreCleanupReady(): boolean {
    return !this.hasPendingMigration()
  }

  hasEmbeddedPayload(): boolean {
    return this.embeddedPayloadPresent
  }

  captureCoreProjectionHashes(
    workspaceSession: WorkspaceSessionState,
    workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  ): Partial<Record<ExecutionHostId, string>> {
    const hashes: Partial<Record<ExecutionHostId, string>> = {
      [LOCAL_EXECUTION_HOST_ID]: workspaceSessionHash(workspaceSession)
    }
    for (const [rawHostId, session] of Object.entries(workspaceSessionsByHostId ?? {})) {
      const hostId = normalizeExecutionHostId(rawHostId)
      if (hostId && session) {
        hashes[hostId] = workspaceSessionHash(session)
      }
    }
    return hashes
  }

  commitCoreProjectionHashes(hashes: Partial<Record<ExecutionHostId, string>>): void {
    this.synchronizedCoreHashes.clear()
    for (const [rawHostId, hash] of Object.entries(hashes)) {
      const hostId = normalizeExecutionHostId(rawHostId)
      if (hostId && hash) {
        this.synchronizedCoreHashes.set(hostId, hash)
      }
    }
  }
  refreshPartitionsNewerThanCoreProjection(hashes: Partial<Record<ExecutionHostId, string>>): void {
    for (const [hostId, session] of this.sessions) {
      if (workspaceSessionHash(session) !== hashes[hostId]) {
        this.markDirty(hostId, session, 'patch')
      }
    }
  }

  beginFinalFlush(): void {
    this.finalFlushStarted = true
    this.clearWriteTimer()
  }

  freeze(): void {
    this.frozen = true
    this.clearWriteTimer()
  }
}
