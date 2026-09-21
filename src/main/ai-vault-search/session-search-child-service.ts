import type { AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import {
  reconcileSessionSearchInService,
  searchSessionsInService,
  sessionSearchStatusInService
} from '../ai-vault/session-scanner-service-spawn'
import type { SessionSearchService } from './session-search-service'

/**
 * The desktop's `SessionSearchService`: every call is forwarded to the scanner
 * child that owns the database. This process never opens the index file.
 *
 * A transport failure is a child that is starting, restarting or refusing, which
 * is `not-ready` rather than an error: the caller asked whether this host can
 * answer, and "not yet" is an answer. A child that is up and has no indexer says
 * `disabled` for itself.
 */
export function createChildSessionSearchService(
  calls = {
    search: searchSessionsInService,
    status: sessionSearchStatusInService,
    reconcile: reconcileSessionSearchInService
  }
): SessionSearchService {
  return {
    search: async (request) => {
      try {
        return await calls.search(request)
      } catch {
        return { kind: 'unavailable', reason: 'not-ready' }
      }
    },
    status: async (): Promise<AiVaultSearchStatus> => {
      try {
        return await calls.status()
      } catch {
        return unavailableSessionSearchStatus()
      }
    },
    reconcile: async () => {
      // Swallowed for the same reason: the caller's next search reports the state
      // of the index, and a freshness wait that cannot run is a stale page, not a throw.
      await calls.reconcile().catch(() => undefined)
    }
  }
}
