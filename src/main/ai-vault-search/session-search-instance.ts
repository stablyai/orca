import type SyncDatabase from '../sqlite/sync-database'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { SessionSearchEngine } from './session-search-engine'
import { SessionSearchIndexer } from './session-search-indexer'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'
import { openSessionSearchDatabase, removeSessionSearchDatabase } from './session-search-schema'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import {
  createSessionSearchService,
  type SessionSearchHostScope,
  type SessionSearchService
} from './session-search-service'

export type SessionSearchInstanceOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  onError?: (error: unknown) => void
  /** Tests only: shortens the loop so a settings change is observable in one tick. */
  reconcileIntervalMs?: number
}

type LiveIndex = {
  indexer: SessionSearchIndexer
  engine: SessionSearchEngine
  /** The engine's own handle; the indexer's store keeps a second, private one. */
  db: SyncDatabase
  service: SessionSearchService
}

/**
 * The one object that holds a host's live indexer and engine, and the three
 * recipes that change them.
 *
 * The indexer is immutable after construction, so there is nothing here that
 * reconfigures one: a settings change is `close()` and a new instance, disabling
 * is `close()` with no replacement, and clearing is `close()`, remove the
 * database, construct again. The new instance's first sweep purges a narrowed
 * window and admits a widened one, so neither of those needs a path of its own.
 *
 * Lives in whichever process runs the transcript reader for this host. Nothing
 * here knows about IPC, Electron or a settings store; the caller supplies the
 * resolved settings and scan roots.
 */
export class SessionSearchInstance {
  private live: LiveIndex | null = null
  private settings: AiVaultSearchSettings = { enabled: false, historyDays: null }
  private readonly onError: (error: unknown) => void

  constructor(private readonly options: SessionSearchInstanceOptions) {
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
  }

  /** True once an indexer exists; false while disabled or while a construction is failing. */
  get running(): boolean {
    return this.live !== null
  }

  /** Close whatever is live and construct from `next`. A no-op change still restarts. */
  apply(next: AiVaultSearchSettings): void {
    this.settings = next
    this.closeLive()
    this.construct()
  }

  /** Throw the index away, then rebuild it if consent still stands. */
  clear(): void {
    this.closeLive()
    removeSessionSearchDatabase(this.options.databasePath)
    this.construct()
  }

  close(): void {
    this.closeLive()
  }

  async search(
    request: AiVaultSearchRequest,
    hostScope?: SessionSearchHostScope
  ): Promise<AiVaultSearchResponse> {
    const live = this.live
    // Consent and readiness first, for a scoped request exactly as for an
    // unscoped one: a host the user can switch on must say so, not blame a scope.
    if (!live) {
      return { kind: 'unavailable', reason: this.settings.enabled ? 'not-ready' : 'disabled' }
    }
    return live.service.search(request, hostScope)
  }

  status(): AiVaultSearchStatus {
    const live = this.live
    if (!live) {
      return { ...unavailableSessionSearchStatus(), enabled: this.settings.enabled }
    }
    return {
      enabled: true,
      ...live.indexer.status(),
      generation: live.engine.generation()
    }
  }

  async reconcile(): Promise<void> {
    await this.live?.service.reconcile()
  }

  /** Tests only: resolves once the work loop has no pass in flight. */
  settled(): Promise<void> {
    return this.live?.indexer.settled() ?? Promise.resolve()
  }

  private construct(): void {
    if (!this.settings.enabled) {
      return
    }
    const { historyDays } = this.settings
    let indexer: SessionSearchIndexer | null = null
    let db: SyncDatabase | null = null
    try {
      indexer = new SessionSearchIndexer({
        databasePath: this.options.databasePath,
        roots: this.options.roots,
        resolveRoots: this.options.resolveRoots,
        historyDays,
        onError: this.onError,
        ...(this.options.reconcileIntervalMs === undefined
          ? {}
          : { reconcileIntervalMs: this.options.reconcileIntervalMs })
      })
      db = openSessionSearchDatabase(this.options.databasePath)
      // Later expiry comes from the indexer purge, which also invalidates page cursors.
      const engineOptions = {
        retentionCutoffMs: sessionSearchHistoryCutoffMs(historyDays, Date.now())
      }
      const engine = new SessionSearchEngine(db, engineOptions)
      this.live = {
        indexer,
        engine,
        db,
        service: createSessionSearchService({ engine, indexer })
      }
      void indexer.start().catch(this.onError)
    } catch (error) {
      // A failed open must leave nothing half-built: the indexer stakes the
      // database path when its store opens, and only close() releases it.
      db?.close()
      indexer?.close()
      this.live = null
      this.onError(error)
    }
  }

  private closeLive(): void {
    const live = this.live
    this.live = null
    if (!live) {
      return
    }
    try {
      live.indexer.close()
    } finally {
      live.db.close()
    }
  }
}
