import { withinSessionSearchDeadline } from '../../ai-vault-search/session-search-request-deadline'
import type { SessionSearchIndexerOptions } from '../../ai-vault-search/indexing/session-search-indexer-options'
import { unavailableSessionSearchStatus } from '../../../shared/ai-vault/search/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../../shared/ai-vault/search/ai-vault-search-contract'
import { SessionSearchInstance } from '../../ai-vault-search/session-search-instance'
import {
  sameSessionSearchRoots,
  type SessionSearchScanRoots
} from '../../ai-vault-search/discovery/session-search-scan-roots'
import { isSqliteAvailable } from '../../sqlite/sync-database'
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
  private applying = 0
  private enabled = false
  private instance: SessionSearchInstance | null = null
  private databasePath: string | null = null
  private roots: SessionSearchScanRoots | null = null

  constructor(private readonly resolveRoots?: SessionSearchIndexerOptions['resolveRoots']) {}

  apply(init: AiVaultSessionSearchInit): Promise<void> {
    this.enabled = init.settings.enabled
    this.applying++
    const operation = this.transition.then(() => this.applySettings(init))
    this.transition = operation
      .catch((error: unknown) => console.warn('[ai-vault-search]', error))
      .finally(() => {
        this.applying--
      })
    return this.transition
  }

  private async applySettings(init: AiVaultSessionSearchInit): Promise<void> {
    if (!isSqliteAvailable()) {
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
    const instance = this.instance
    if (request.operation === 'searchStatus') {
      return {
        operation: 'searchStatus',
        value: this.enabled
          ? { ...((await instance?.status()) ?? unavailableSessionSearchStatus()), enabled: true }
          : unavailableSessionSearchStatus()
      }
    }
    if (request.operation === 'searchReconcile') {
      await withinSessionSearchDeadline(
        this.transition.then(() => this.instance?.reconcile(signal)),
        signal
      )
      return { operation: 'searchReconcile', value: null }
    }
    if (request.operation === 'searchClear') {
      if (!instance && !this.applying) {
        throw new Error('Agent Session History search is not available.')
      }
      await withinSessionSearchDeadline(
        this.transition.then(() => this.instance?.clear(signal)),
        signal
      )
      return { operation: 'searchClear', value: null }
    }
    return {
      operation: 'searchSessions',
      value: !this.enabled
        ? { kind: 'unavailable', reason: 'disabled' }
        : this.applying || !instance
          ? { kind: 'unavailable', reason: 'not-ready' }
          : await instance.search(
              AiVaultSearchRequestSchema.parse(request.request),
              request.hostScope,
              signal
            )
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
