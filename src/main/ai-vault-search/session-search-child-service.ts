import type { AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import {
  reconcileSessionSearchInService,
  searchSessionsInService,
  sessionSearchStatusInService
} from '../ai-vault/session-scanner-service-spawn'
import type { SessionSearchService } from './session-search-service'

/** Forward to the database-owning child; failed searches return not-ready while logging the error. */
export function createChildSessionSearchService(
  calls = {
    search: searchSessionsInService,
    status: sessionSearchStatusInService,
    reconcile: reconcileSessionSearchInService
  }
): SessionSearchService {
  return {
    search: async (request, hostScope) => {
      try {
        return await calls.search(request, hostScope)
      } catch (error) {
        console.warn('[ai-vault-search] search failed', error)
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
      // A failed freshness wait leaves results stale; the next search reports availability.
      await calls.reconcile().catch(() => undefined)
    }
  }
}
