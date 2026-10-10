import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import type { SessionSearchEngine } from './session-search-engine'
import type { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchCursorError } from './session-search-page-cursor'

/**
 * What the answering host made of a scope identity; absent searches everything.
 *
 * Beside the request, not in `filters.scopePaths`: that field is capped at 64 for
 * the clients that write it, and the scanner child re-parses the request with the
 * same schema. `unknown` travels here too, because consent and readiness are
 * answered below and owe the reader a verdict first.
 */
export type SessionSearchHostScope =
  | { kind: 'resolved'; paths: readonly string[] }
  | { kind: 'unknown' }

export type SessionSearchService = {
  search(
    req: AiVaultSearchRequest,
    hostScope?: SessionSearchHostScope
  ): Promise<AiVaultSearchResponse>
  status(): Promise<AiVaultSearchStatus>
  reconcile(): Promise<void>
}

export function createSessionSearchService({
  engine,
  indexer
}: {
  engine: SessionSearchEngine
  indexer: Pick<SessionSearchIndexer, 'status' | 'reconcile'>
}): SessionSearchService {
  return {
    reconcile: () => indexer.reconcile({ full: true }),
    status: async () => ({ enabled: true, ...indexer.status(), generation: engine.generation() }),
    search: async (request, hostScope) => {
      // Reached only through a live index, so consent and readiness already answered.
      if (hostScope?.kind === 'unknown') {
        return { kind: 'unavailable', reason: 'scope-unknown' }
      }
      if (request.cursor === '') {
        return { kind: 'malformed-cursor' }
      }
      try {
        const result = engine.search(
          hostScope
            ? { ...request, filters: { ...request.filters, scopePaths: hostScope.paths } }
            : request
        )
        return {
          kind: 'results',
          hits: result.hits.map(
            ({
              filePath,
              codexHome,
              source,
              evidence,
              resumeCommand,
              duplicateCount: _duplicateCount,
              ...hit
            }) => ({
              ...hit,
              source: { presence: source, filePath, ...(codexHome === null ? {} : { codexHome }) },
              evidence:
                evidence === null
                  ? null
                  : {
                      snippet: evidence.snippet,
                      role: evidence.role,
                      timestamp: evidence.timestamp
                    },
              ...(source === 'present' ? { resumeCommand } : {})
            })
          ),
          page: result.page,
          generation: result.generation,
          truncated: { ...result.truncated, freshness: false },
          durationMs: result.durationMs,
          ...(request.debug
            ? {
                debug: {
                  route: result.planner.route,
                  ...(result.planner.repairedTerms
                    ? { repairedTerms: result.planner.repairedTerms }
                    : {}),
                  plannerReport: {
                    route: result.planner.route,
                    scope: result.planner.tier,
                    ...(result.planner.repairedTerms
                      ? { repairedTerms: result.planner.repairedTerms }
                      : {})
                  }
                }
              }
            : {})
        }
      } catch (error) {
        if (!(error instanceof SessionSearchCursorError)) {
          throw error
        }
        return error.rejection === 'stale-generation'
          ? {
              kind: 'stale-cursor',
              generation: error.actualGeneration,
              ...(error.expectedGeneration === undefined
                ? {}
                : { expectedGeneration: error.expectedGeneration })
            }
          : { kind: 'malformed-cursor' }
      }
    }
  }
}
