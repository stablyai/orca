import type {
  OrcadMigrationCatalogAbortResult,
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

  getOrcadMigrationCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
    return getOrcadMigrationCatalogState({
      store: this.requireMigrationStore('getOrcadMigrationCatalogState'),
      manifest,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  /**
   * The moved shell history store load left waiting, installed once this runtime can see the
   * host's shells. An unanswered inventory leaves it for the next catalog-state query.
   */
  async installPendingOrcadMigrationShellHistory(): Promise<void> {
    const store = this.store
    // Why: runs on every orcad start; with nothing to install it must not pay a process inventory.
    if (
      !store?.installPendingOrcadMigrationReceivedBlobs ||
      !store.hasPendingOrcadMigrationShellHistory?.()
    ) {
      return
    }
    // Daemon shells that outlived a restart count as live only once the inventory recorded them.
    // Why the real worktrees: an empty list re-files sessions it cannot resolve and drops their
    // restored orchestration receipts.
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

  // The last shell of a worktree exiting releases a moved history that waited on it.
  override onPtyExit(
    ...args: Parameters<OrcaRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<OrcaRuntimeWithResolveWaiter['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    // The store checks its deferred set first, so an exit in any other worktree costs one lookup.
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

  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId).size > 0

  // The capability check covers the captured Store, not a different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
