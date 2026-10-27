import type { SessionSearchProjectOwnership } from './session-search-project-ownership'
import type {
  AiVaultSearchRequest,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../../shared/ai-vault-search-types'
import type { SessionSearchEngine } from './session-search-engine'
import type { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchCursorError } from './session-search-page-cursor'

/** Host scope bypasses the client path cap; absent scope leaves request filters unchanged. */
export type SessionSearchHostScope =
  | { kind: 'resolved'; paths: readonly string[] }
  | {
      kind: 'canonical'
      selection: SessionSearchProjectOwnership
    }
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
      // The live-index route has already checked consent and readiness.
      if (hostScope?.kind === 'unknown') {
        return { kind: 'unavailable', reason: 'scope-unknown' }
      }
      if (request.cursor === '') {
        return { kind: 'malformed-cursor' }
      }
      try {
        const result = engine.search(
          hostScope
            ? {
                ...request,
                filters: {
                  ...request.filters,
                  ...(hostScope.kind === 'canonical'
                    ? { ownership: hostScope.selection }
                    : { scopePaths: hostScope.paths })
                }
              }
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
