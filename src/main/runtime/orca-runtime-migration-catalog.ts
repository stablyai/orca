import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationImportResult,
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
  importOrcadMigrationCatalogDurably,
  stageOrcadMigrationCatalogDurably
} from './orcad-migration-catalog-import'
import { OrcaRuntimeWithTerminalSendReceipts } from './orca-runtime-terminal-send-receipts'

export class OrcaRuntimeWithMigrationCatalog extends OrcaRuntimeWithTerminalSendReceipts {
  async importOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationImportResult> {
    const store = this.store
    const importCatalog = store?.importOrcadMigrationCatalog
    const flushPending = store?.flushPendingOrThrowAsync
    if (!store || !importCatalog || !flushPending) {
      throw new Error('runtime_unavailable')
    }
    return importOrcadMigrationCatalogDurably({
      store: {
        importOrcadMigrationCatalog: (input, inputOptions) =>
          importCatalog.call(store, input, inputOptions),
        flushPendingOrThrowAsync: (flushOptions) => flushPending.call(store, flushOptions)
      },
      manifest,
      signal: options.signal,
      onDurableImport: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  async stageOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogState> {
    const store = this.store
    const stage = store?.stageOrcadMigrationCatalog
    const flush = store?.flushPendingOrThrowAsync
    if (!store || !stage || !flush) {
      throw new Error('runtime_unavailable')
    }
    return stageOrcadMigrationCatalogDurably({
      store: {
        stageOrcadMigrationCatalog: (input, inputOptions) => stage.call(store, input, inputOptions),
        flushPendingOrThrowAsync: (flushOptions) => flush.call(store, flushOptions)
      },
      manifest,
      signal: options.signal
    })
  }

  async commitStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogState> {
    const store = this.store
    const commit = store?.commitStagedOrcadMigrationCatalog
    const flush = store?.flushPendingOrThrowAsync
    if (!store || !commit || !flush) {
      throw new Error('runtime_unavailable')
    }
    return commitStagedOrcadMigrationCatalogDurably({
      store: {
        commitStagedOrcadMigrationCatalog: (input, inputOptions) =>
          commit.call(store, input, inputOptions),
        flushPendingOrThrowAsync: (flushOptions) => flush.call(store, flushOptions)
      },
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
    const store = this.store
    const stageChunk = store?.stageOrcadMigrationSnapshotChunk
    if (!store || !stageChunk) {
      throw new Error('runtime_unavailable')
    }
    return stageChunk.call(store, request)
  }

  async abortStagedOrcadMigrationCatalog(
    manifest: OrcadMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<OrcadMigrationCatalogAbortResult> {
    const store = this.store
    const abort = store?.abortStagedOrcadMigrationCatalog
    const flush = store?.flushPendingOrThrowAsync
    if (!store || !abort || !flush) {
      throw new Error('runtime_unavailable')
    }
    return abortStagedOrcadMigrationCatalogDurably({
      store: {
        abortStagedOrcadMigrationCatalog: (input) => abort.call(store, input),
        flushPendingOrThrowAsync: (flushOptions) => flush.call(store, flushOptions)
      },
      manifest,
      signal: options.signal
    })
  }

  getOrcadMigrationCatalogState(manifest: OrcadMigrationManifest): OrcadMigrationCatalogState {
    const store = this.store
    const readState = store?.getOrcadMigrationCatalogState
    if (!store || !readState) {
      throw new Error('runtime_unavailable')
    }
    return getOrcadMigrationCatalogState({
      store: { getOrcadMigrationCatalogState: (input) => readState.call(store, input) },
      manifest
    })
  }
}
