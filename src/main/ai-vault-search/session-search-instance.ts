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
import { removeSessionSearchDatabase } from './session-search-schema'
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
  private transition = Promise.resolve()
  private readonly onError: (error: unknown) => void
  constructor(private readonly options: SessionSearchInstanceOptions) {
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
  }
  get running(): boolean {
    return this.live !== null
  }
  apply(next: AiVaultSearchSettings): Promise<void> {
    this.settings = next
    return this.queue(next, false)
  }
  clear(): Promise<void> {
    return this.queue(this.settings, true)
  }
  close(): Promise<void> {
    return (this.transition = this.transition.then(() => this.closeLive()).catch(this.onError))
  }
  private queue(settings: AiVaultSearchSettings, clear: boolean): Promise<void> {
    const old = this.live
    this.live = null
    old?.indexer.close()
    const retired = old
      ? Promise.all([old.indexer.retired(), old.readers.close()])
      : Promise.resolve()
    return (this.transition = this.transition
      .then(async () => {
        await retired
        await this.closeLive()
        if (clear) {
          removeSessionSearchDatabase(this.options.databasePath)
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
      .catch(this.onError))
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
    try {
      return (
        (await live.readers.query(request, scope, signal)).result ?? {
          kind: 'unavailable',
          reason: 'not-ready'
        }
      )
    } catch (error) {
      this.onError(error)
      return { kind: 'unavailable', reason: 'not-ready' }
    }
  }
  async status(): Promise<AiVaultSearchStatus> {
    const live = this.live
    if (!live) {
      return { ...unavailableSessionSearchStatus(), enabled: this.settings.enabled }
    }
    try {
      return {
        enabled: true,
        ...live.indexer.status(),
        generation: (await live.readers.status()).generation ?? 0
      }
    } catch {
      return { ...unavailableSessionSearchStatus(), enabled: true }
    }
  }
  async reconcile(): Promise<void> {
    await this.transition
    await this.live?.indexer.reconcile({ full: true })
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
