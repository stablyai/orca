import type { SessionSearchIndexerOptions } from '../../ai-vault-search/session-search-indexer-options'
import { unavailableSessionSearchStatus } from '../../../shared/ai-vault/search/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../../shared/ai-vault/search/ai-vault-search-contract'
import { SessionSearchInstance } from '../../ai-vault-search/session-search-instance'
import {
  sameSessionSearchRoots,
  type SessionSearchScanRoots
} from '../../ai-vault-search/session-search-scan-roots'
import { sessionSearchSqliteAvailable } from '../../ai-vault-search/session-search-sqlite-support'
import type {
  AiVaultServiceRequest,
  AiVaultServiceResultValue,
  AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

type SearchOperation = Extract<
  AiVaultServiceRequest,
  { operation: 'searchSessions' | 'searchStatus' | 'searchReconcile' | 'searchClear' }
>

/** Keep indexing with transcript readers; callers access the database through service IPC. */
export class SessionScannerServiceSearch {
  private transition = Promise.resolve()
  private instance: SessionSearchInstance | null = null
  private databasePath: string | null = null
  private roots: SessionSearchScanRoots | null = null

  constructor(private readonly resolveRoots?: SessionSearchIndexerOptions['resolveRoots']) {}

  apply(init: AiVaultSessionSearchInit): Promise<void> {
    return (this.transition = this.transition.then(() => this.applySettings(init)))
  }

  private async applySettings(init: AiVaultSessionSearchInit): Promise<void> {
    if (!sessionSearchSqliteAvailable()) {
      return
    }
    if (this.instance && this.databasePath !== init.databasePath) {
      await this.closeInstance()
    }
    if (this.instance && this.roots && !sameSessionSearchRoots(this.roots, init.roots)) {
      // Refresh fallback roots for callers without a resolver.
      await this.closeInstance()
    }
    this.databasePath = init.databasePath
    this.roots = init.roots
    this.instance ??= new SessionSearchInstance({
      databasePath: init.databasePath,
      roots: init.roots,
      resolveRoots: this.resolveRoots
    })
    await this.instance.apply(init.settings)
  }

  handles(request: AiVaultServiceRequest): request is SearchOperation {
    return (
      request.operation === 'searchSessions' ||
      request.operation === 'searchStatus' ||
      request.operation === 'searchReconcile' ||
      request.operation === 'searchClear'
    )
  }

  async execute(
    request: SearchOperation,
    signal?: AbortSignal
  ): Promise<AiVaultServiceResultValue> {
    await this.transition
    const instance = this.instance
    if (request.operation === 'searchStatus') {
      return {
        operation: 'searchStatus',
        value: (await instance?.status()) ?? unavailableSessionSearchStatus()
      }
    }
    if (request.operation === 'searchReconcile') {
      await instance?.reconcile()
      return { operation: 'searchReconcile', value: null }
    }
    if (request.operation === 'searchClear') {
      if (!instance) {
        throw new Error('Agent Session History search is not available.')
      }
      await instance.clear()
      return { operation: 'searchClear', value: null }
    }
    return {
      operation: 'searchSessions',
      value: instance
        ? await instance.search(
            AiVaultSearchRequestSchema.parse(request.request),
            request.hostScope,
            signal
          )
        : { kind: 'unavailable', reason: 'disabled' }
    }
  }

  close(): Promise<void> {
    return (this.transition = this.transition.then(() => this.closeInstance()))
  }

  private async closeInstance(): Promise<void> {
    const retired = this.instance?.close()
    this.instance = null
    this.databasePath = null
    this.roots = null
    await retired
  }
}
