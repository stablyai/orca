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
import type { WslMoveLiveTerminal } from '../persistence/moving-wsl-projects/wsl-move-gate-facts'
import type { RuntimeStore } from './runtime-store-contract'
import type { SessionReadTerminalScrollbackResult } from '../../shared/rpc-contract/session-terminal-scrollback-params'
import {
  readHostTerminalScrollback,
  type HostTerminalScrollbackReadRequest
} from './host-terminal-scrollback-read'

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
    options: {
      signal?: AbortSignal
      expectedBlobs?: readonly OrcadMigrationBlobDescriptor[]
    } = {}
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

  // A moved history is this machine's; a same-id SSH twin's shell never writes it.
  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId, undefined, { resolvedConnectionId: null }).size > 0

  /** A migrated pane's stored scrollback, for a client whose own copy is gone or never existed. */
  async readTerminalScrollbackForClient(
    request: HostTerminalScrollbackReadRequest
  ): Promise<SessionReadTerminalScrollbackResult> {
    const store = this.store
    const readSnapshot = store?.readTerminalScrollbackSnapshotAsync
    const statSnapshotSize = store?.statTerminalScrollbackSnapshotSize
    if (!store || !readSnapshot || !statSnapshotSize) {
      throw new Error('runtime_unavailable')
    }
    return readHostTerminalScrollback(
      {
        resolveWorktreeId: async (selector) => (await this.resolveWorktreeSelector(selector)).id,
        getWorkspaceSession: (worktreeId) => this.workspaceSessions.get(worktreeId),
        statSnapshotSize: (ref) => statSnapshotSize.call(store, ref),
        readSnapshot: (ref) => readSnapshot.call(store, ref)
      },
      request
    )
  }

  /** This desktop's live terminals in the workspaces, for a WSL move's gate and pause. */
  listWslMoveLiveTerminals(workspaceIds: readonly string[]): WslMoveLiveTerminal[] {
    const terminals = new Map<string, WslMoveLiveTerminal>()
    for (const workspaceId of workspaceIds) {
      // Local only: a same-id SSH twin's terminals are another host's.
      for (const ptyId of this.getLivePtyIdsForWorktree(workspaceId, undefined, {
        resolvedConnectionId: null
      })) {
        const pty = this.ptysById.get(ptyId)
        terminals.set(ptyId, {
          ptyId,
          workspaceId,
          paneKey: pty?.paneKey ?? null,
          wslDistro: pty?.wslDistro ?? null,
          foregroundAgent: pty?.foregroundAgent ?? null
        })
      }
    }
    return [...terminals.values()]
  }

  // The capability check covers the captured Store, not a different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
