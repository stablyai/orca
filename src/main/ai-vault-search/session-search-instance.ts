import { withinSessionSearchDeadline } from './session-search-request-deadline'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault/search/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault/search/ai-vault-search-client'
import type { AiVaultSearchSettings } from '../../shared/ai-vault/search/ai-vault-search-settings'
import { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchReaders } from './session-search-readers'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'
import { removeSessionSearchDatabaseAsync } from './session-search-schema'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import type { SessionSearchIndexerOptions } from './session-search-indexer-options'
import type { SessionSearchHostScope } from './session-search-service'

export type SessionSearchInstanceOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  resolveRoots?: SessionSearchIndexerOptions['resolveRoots']
  onError?: (error: unknown) => void
  reconcileIntervalMs?: number
}
type LiveIndex = { indexer: SessionSearchIndexer; readers: SessionSearchReaders }

/** Replace the writer and readers together, awaiting their exits before reopening or unlinking. */
export class SessionSearchInstance {
  private live: LiveIndex | null = null
  private settings: AiVaultSearchSettings = { enabled: false, historyDays: null }
  private transition: Promise<void> | null = null
  private readonly onError: (error: unknown) => void
  constructor(private readonly options: SessionSearchInstanceOptions) {
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
  }
  get running(): boolean {
    return this.live !== null
  }
  apply(next: AiVaultSearchSettings): Promise<void> {
    this.settings = next
    return this.queue(next, false).catch(() => undefined)
  }
  clear(signal?: AbortSignal): Promise<void> {
    return withinSessionSearchDeadline(this.queue(this.settings, true), signal)
  }
  close(): Promise<void> {
    return this.trackTransition((this.transition ?? Promise.resolve()).then(() => this.closeLive()))
  }
  private trackTransition(operation: Promise<void>): Promise<void> {
    const pending = operation.catch(this.onError).finally(() => {
      if (this.transition === pending) {
        this.transition = null
      }
    })
    this.transition = pending
    return pending
  }
  private queue(settings: AiVaultSearchSettings, clear: boolean): Promise<void> {
    const old = this.live
    this.live = null
    old?.indexer.close()
    const retired = old
      ? Promise.all([old.indexer.retired(), old.readers.close()])
      : Promise.resolve()
    const operation = (this.transition ?? Promise.resolve()).then(async () => {
      await retired
      await this.closeLive()
      if (clear) {
        await removeSessionSearchDatabaseAsync(this.options.databasePath)
      }
      if (!settings.enabled) {
        return
      }
      const indexer = new SessionSearchIndexer({
        ...this.options,
        historyDays: settings.historyDays
      })
      try {
        await indexer.initialize()
      } catch (error) {
        indexer.close()
        await indexer.retired()
        throw error
      }
      const readers = new SessionSearchReaders(
        this.options.databasePath,
        sessionSearchHistoryCutoffMs(settings.historyDays, Date.now())
      )
      this.live = { indexer, readers }
      void indexer.start().catch(this.onError)
    })
    this.trackTransition(operation)
    return operation
  }
  async search(
    request: AiVaultSearchRequest,
    scope?: SessionSearchHostScope,
    signal?: AbortSignal
  ): Promise<AiVaultSearchResponse> {
    const live = this.live
    if (!live) {
      return { kind: 'unavailable', reason: this.settings.enabled ? 'not-ready' : 'disabled' }
    }
    const response = await live.readers.query(request, scope, signal)
    if (!response.result) {
      throw new Error('Could not search sessions')
    }
    return response.result
  }
  async status(): Promise<AiVaultSearchStatus> {
    const live = this.live
    if (!this.settings.enabled || !live) {
      return {
        ...unavailableSessionSearchStatus(),
        enabled: this.settings.enabled,
        ...(this.settings.enabled && this.transition
          ? { phase: 'indexing', messagesIndexed: 0 }
          : {})
      }
    }
    return {
      enabled: true,
      ...live.indexer.status(),
      generation: live.indexer.generation()
    }
  }
  reconcile(signal?: AbortSignal): Promise<void> {
    return withinSessionSearchDeadline(
      (this.transition ?? Promise.resolve()).then(() =>
        this.live?.indexer.reconcile({ full: true })
      ),
      signal
    )
  }
  async settled(): Promise<void> {
    await this.transition
    await this.live?.indexer.settled()
  }
  private async closeLive(): Promise<void> {
    const live = this.live
    this.live = null
    if (!live) {
      return
    }
    live.indexer.close()
    await Promise.all([live.indexer.retired(), live.readers.close()])
  }
}
