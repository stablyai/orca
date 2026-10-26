import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogReference,
  OrcadMigrationCatalogReferenceAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration/orcad-migration-scrollback'
import type {
  OrcadMigrationBlobChunkRequest,
  OrcadMigrationBlobChunkResult,
  OrcadMigrationBlobDescriptor
} from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import {
  abortStagedOrcadMigrationCatalogByReferenceDurably,
  abortStagedOrcadMigrationCatalogDurably,
  commitStagedOrcadMigrationCatalogDurably,
  getOrcadMigrationCatalogState,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { RuntimeStore } from './runtime-store-contract'

type MigrationStoreKey =
  | 'stageOrcadMigrationCatalog'
  | 'commitStagedOrcadMigrationCatalog'
  | 'stageOrcadMigrationSnapshotChunk'
  | 'stageOrcadMigrationBlobChunk'
  | 'abortStagedOrcadMigrationCatalog'
  | 'abortStagedOrcadMigrationCatalogByReference'
  | 'getOrcadMigrationCatalogState'
  | 'flushPendingOrThrowAsync'

/** The destination half of a dormant catalog migration; every mutation is flushed before it answers. */
export abstract class OrcaRuntimeWithMigrationCatalog extends OrcaRuntimeWithResolveWaiter {
  async stageOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogState> {
    return stageOrcadMigrationCatalogDurably({
      store: this.requireMigrationStore('stageOrcadMigrationCatalog', 'flushPendingOrThrowAsync'),
      manifest,
      signal: options.signal
    })
  }

  async commitStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal; expectedBlobs?: readonly OrcadMigrationBlobDescriptor[] } = {}
  ): Promise<OrcadMigrationCatalogState> {
    return commitStagedOrcadMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'commitStagedOrcadMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal,
      expectedBlobs: options.expectedBlobs,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells,
      onDurableCommit: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  stageOrcadMigrationSnapshotChunk(
    request: OrcadMigrationSnapshotChunkRequest
  ): OrcadMigrationSnapshotChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageOrcadMigrationSnapshotChunk')
      .stageOrcadMigrationSnapshotChunk!(request)
  }

  stageOrcadMigrationBlobChunk(
    request: OrcadMigrationBlobChunkRequest
  ): OrcadMigrationBlobChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageOrcadMigrationBlobChunk').stageOrcadMigrationBlobChunk!(
      request
    )
  }

  async abortStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogAbortResult> {
    return abortStagedOrcadMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'abortStagedOrcadMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal
    })
  }

  async abortStagedOrcadMigrationCatalogByReference(
    reference: OrcadMigrationCatalogReference,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogReferenceAbortResult> {
    return abortStagedOrcadMigrationCatalogByReferenceDurably({
      store: this.requireMigrationStore(
        'abortStagedOrcadMigrationCatalogByReference',
        'flushPendingOrThrowAsync'
      ),
      reference,
      signal: options.signal
    })
  }

  getOrcadMigrationCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
    return getOrcadMigrationCatalogState({
      store: this.requireMigrationStore('getOrcadMigrationCatalogState'),
      manifest,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  /** Install deferred migrated history after host-shell discovery; unanswered inventory retries on the next catalog query. */
  async installPendingOrcadMigrationShellHistory(): Promise<void> {
    const store = this.store
    // Every daemon start calls this; no pending blobs must cost no inventory.
    if (
      !store?.installPendingOrcadMigrationReceivedBlobs ||
      !store.hasPendingOrcadMigrationShellHistory?.()
    ) {
      return
    }
    // Inventory first to find restart-surviving shells; real worktrees preserve their restored orchestration receipts.
    if (
      this.ptyController?.listProcesses &&
      !(await this.refreshPtyWorktreeRecordsWithControllerInventory([
        ...(await this.getResolvedWorktreeMap()).values()
      ]))
    ) {
      console.warn('[orcad-migration] shell history waits: the terminal inventory did not answer')
      return
    }
    store.installPendingOrcadMigrationReceivedBlobs({
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  override onPtyExit(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    if (worktreeId) {
      try {
        this.store?.installDeferredOrcadMigrationShellHistory?.(worktreeId, {
          worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
        })
      } catch (error) {
        console.error('[orcad-migration] installing deferred shell history failed:', error)
      }
    }
    return result
  }

  // Migrated history belongs here; same-id SSH twins never write it.
  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId, undefined, { resolvedConnectionId: null }).size > 0

  // Check the captured Store, not a potentially different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
