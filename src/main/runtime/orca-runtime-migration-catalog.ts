import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import {
  abortStagedOrcadMigrationCatalogDurably,
  commitStagedOrcadMigrationCatalogDurably,
  getOrcadMigrationCatalogState,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { RuntimeStore } from './runtime-store-contract'
import type { Store } from '../persistence'

/** The destination half of a dormant catalog migration; every mutation is flushed before it answers. */
export class OrcaRuntimeWithMigrationCatalog extends OrcaRuntimeWithResolveWaiter {
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
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogState> {
    return commitStagedOrcadMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'commitStagedOrcadMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal,
      onDurableCommit: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  stageOrcadMigrationSnapshotChunk(
    request: OrcadMigrationSnapshotChunkRequest
  ): OrcadMigrationSnapshotChunkResult {
    return this.requireMigrationStore(
      'stageOrcadMigrationSnapshotChunk'
    ).stageOrcadMigrationSnapshotChunk(request)
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
      manifest
    })
  }

  /** A partial store (tests, headless hosts) lacks some optional methods; refuse rather than half-run. */
  private requireMigrationStore<K extends keyof RuntimeStore & keyof Store>(
    ...methods: K[]
  ): Pick<Store, K> {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
