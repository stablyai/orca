import {
  AiVaultSearchRequestSchema,
  AiVaultSearchResponseSchema,
  AiVaultSearchStatusRequestSchema,
  AiVaultSearchStatusSchema
} from '../../shared/ai-vault-search-contract'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchResponse, AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import {
  redactForTransport,
  type SessionSearchTransport
} from '../../shared/ai-vault-search-transport'
import type { SessionSearchService } from './session-search-service'

let service: SessionSearchService | null = null

export function setSessionSearchService(next: SessionSearchService | null): void {
  service = next
}

export async function searchSessionService(
  raw: unknown,
  transport: SessionSearchTransport,
  freshnessTimeoutMs = 5_000
): Promise<AiVaultSearchResponse> {
  const request = AiVaultSearchRequestSchema.parse(raw)
  const current = service
  if (!current) {
    return { kind: 'unavailable', reason: 'no-service' }
  }
  const freshness =
    request.freshness === 'wait-until-current'
      ? await reconcileWithin(current, freshnessTimeoutMs)
      : false
  const result = AiVaultSearchResponseSchema.parse(await current.search(request))
  if (result.kind !== 'results') {
    return result
  }
  const { debug, ...fields } = result
  return {
    ...fields,
    hits: result.hits.map((hit) => redactForTransport(hit, transport)),
    truncated: { ...result.truncated, freshness: result.truncated.freshness || freshness },
    ...(request.debug && debug ? { debug } : {})
  }
}

export async function sessionSearchServiceStatus(raw: unknown = {}): Promise<AiVaultSearchStatus> {
  AiVaultSearchStatusRequestSchema.parse(raw)
  return AiVaultSearchStatusSchema.parse(
    service ? await service.status() : unavailableSessionSearchStatus()
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
