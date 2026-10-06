import {
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusRequestSchema,
  AiVaultSearchStatusSchema
} from '../../shared/ai-vault-search-contract'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import { sessionSearchScopeCatalog } from './session-search-scope-catalog'
import { resolveSessionSearchScope } from './session-search-scope-resolution'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import {
  redactForTransport,
  redactStatusForTransport,
  type SessionSearchTransport
} from '../../shared/ai-vault-search-transport'
import type { SessionSearchService } from './session-search-service'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
import { compatibleSearchAgents } from '../../shared/ai-vault-search-agent-compatibility'

let service: SessionSearchService | null = null

export function setSessionSearchService(next: SessionSearchService | null): void {
  service = next
}

export async function searchSessionService(
  raw: unknown,
  transport: SessionSearchTransport,
  freshnessTimeoutMs = 5_000
): Promise<AiVaultSearchResponse> {
  const parsed = AiVaultSearchRequestSchema.parse(raw)
  const current = service
  if (!current) {
    return { kind: 'unavailable', reason: 'no-service' }
  }
  // The choke point every entry point funnels through, so every host kind
  // resolves alike; the verdict goes to the service, which answers off and
  // not-ready first.
  const { within, supportedAgents, supportsQoderHistory, supportsJcodeHistory, ...request } = parsed
  // Older clients reject the whole page when a hit has an unknown agent tag.
  const requestedAgents = request.filters?.agents
  const agents = requestedAgents?.length ? requestedAgents : AI_VAULT_AGENTS
  const compatibleAgents = compatibleSearchAgents(
    agents,
    transport === 'ipc'
      ? { supportedAgents: [...AI_VAULT_AGENTS] }
      : {
          // An explicit tag also proves the requesting parser understands that agent.
          supportedAgents:
            supportedAgents ?? (requestedAgents?.length ? requestedAgents : undefined),
          supportsQoderHistory,
          supportsJcodeHistory
        }
  )
  const compatibleRequest =
    compatibleAgents.length === 0 || compatibleAgents.length === agents.length
      ? request
      : {
          ...request,
          filters: {
            ...request.filters,
            agents: compatibleAgents
          }
        }
  const hostScope = within
    ? resolveSessionSearchScope(within, sessionSearchScopeCatalog())
    : undefined
  const retrievalScope =
    compatibleAgents.length === 0 && hostScope?.kind !== 'unknown'
      ? { kind: 'resolved' as const, paths: [''] }
      : hostScope
  const freshness =
    request.freshness === 'wait-until-current'
      ? await reconcileWithin(current, freshnessTimeoutMs)
      : false
  const result = AiVaultSearchResponseSchema.parse(
    await current.search(compatibleRequest, retrievalScope)
  )
  if (result.kind !== 'results') {
    return result
  }
  const { debug, ...fields } = result
  return {
    ...fields,
    ...(compatibleAgents.length === 0 ? { page: { cursor: null, hasMore: false } } : {}),
    hits: result.hits
      .filter((hit) => compatibleAgents.includes(hit.agent))
      .map((hit) => redactForTransport(hit, transport)),
    truncated: { ...result.truncated, freshness: result.truncated.freshness || freshness },
    ...(request.debug && debug ? { debug } : {})
  }
}

export async function sessionSearchServiceStatus(
  raw: unknown,
  transport: SessionSearchTransport
): Promise<AiVaultSearchStatus> {
  AiVaultSearchStatusRequestSchema.parse(raw)
  return redactStatusForTransport(
    AiVaultSearchStatusSchema.parse({
      ...(service ? await service.status() : unavailableSessionSearchStatus()),
      supportedAgents: [...AI_VAULT_AGENTS],
      supportsQoderHistory: true,
      supportsJcodeHistory: true
    }),
    transport
  )
}

async function reconcileWithin(current: SessionSearchService, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => current.reconcile())
        .then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
