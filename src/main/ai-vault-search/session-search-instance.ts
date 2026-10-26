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
  reconcileIntervalMs?: number
}

type LiveIndex = {
  indexer: SessionSearchIndexer
  engine: SessionSearchEngine
  /** Reader connection; the indexer owns a separate writer connection. */
  db: SyncDatabase
  service: SessionSearchService
}

/** Replace the indexer and reader together when settings change, closing the old pair first. */
export class SessionSearchInstance {
  private live: LiveIndex | null = null
  private settings: AiVaultSearchSettings = { enabled: false, historyDays: null }
  private readonly onError: (error: unknown) => void

  constructor(private readonly options: SessionSearchInstanceOptions) {
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
  }

  get running(): boolean {
    return this.live !== null
  }

  /** Even unchanged settings restart the indexer. */
  apply(next: AiVaultSearchSettings): void {
    this.settings = next
    this.closeLive()
    this.construct()
  }

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
    // Report disabled or not-ready before checking scope so the client can offer the right recovery.
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
      // Keep pagination stable until an indexer purge expires rows and invalidates cursors.
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
      // Release the writer’s database-path claim if reader construction fails.
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
