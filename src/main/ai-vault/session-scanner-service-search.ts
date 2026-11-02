import type { SessionSearchIndexerOptions } from '../ai-vault-search/session-search-indexer-options'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import { SessionSearchInstance } from '../ai-vault-search/session-search-instance'
import {
  sameSessionSearchRoots,
  type SessionSearchScanRoots
} from '../ai-vault-search/session-search-scan-roots'
import { sessionSearchSqliteAvailable } from '../ai-vault-search/session-search-sqlite-support'
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
  private instance: SessionSearchInstance | null = null
  private databasePath: string | null = null
  private roots: SessionSearchScanRoots | null = null

  constructor(private readonly resolveRoots?: SessionSearchIndexerOptions['resolveRoots']) {}

  apply(init: AiVaultSessionSearchInit): void {
    if (!sessionSearchSqliteAvailable()) {
      return
    }
    if (this.instance && this.databasePath !== init.databasePath) {
      this.close()
    }
    if (this.instance && this.roots && !sameSessionSearchRoots(this.roots, init.roots)) {
      // Refresh fallback roots for callers without a resolver.
      this.close()
    }
    this.databasePath = init.databasePath
    this.roots = init.roots
    this.instance ??= new SessionSearchInstance({
      databasePath: init.databasePath,
      roots: init.roots,
      resolveRoots: this.resolveRoots
    })
    this.instance.apply(init.settings)
  }

  handles(request: AiVaultServiceRequest): request is SearchOperation {
    return (
      request.operation === 'searchSessions' ||
      request.operation === 'searchStatus' ||
      request.operation === 'searchReconcile' ||
      request.operation === 'searchClear'
    )
  }

  async execute(request: SearchOperation): Promise<AiVaultServiceResultValue> {
    const instance = this.instance
    if (request.operation === 'searchStatus') {
      return {
        operation: 'searchStatus',
        value: instance?.status() ?? unavailableSessionSearchStatus()
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
      instance.clear()
      return { operation: 'searchClear', value: null }
    }
    return {
      operation: 'searchSessions',
      value: instance
        ? await instance.search(
            AiVaultSearchRequestSchema.parse(request.request),
            request.hostScope
          )
        : { kind: 'unavailable', reason: 'disabled' }
    }
  }

  close(): void {
    this.instance?.close()
    this.instance = null
    this.databasePath = null
    this.roots = null
  }
}
