import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const ResourceStatusParams = z.object({
  // Why: default off — the command returns the cached poll snapshot; refresh
  // opts into the stale-aware provider fetch (poll throttle and Retry-After still apply).
  refresh: z.boolean().default(false)
})

/**
 * `resource.status` — read-only, identity-free projection of RateLimitService
 * state (see `resource-evidence-projection.ts`). Additive method: an older
 * dispatcher answers `method_not_found`. Never mutates account or credential
 * state; `refresh` reuses the existing stale-aware fetch.
 */
export const RESOURCE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'resource.status',
    params: ResourceStatusParams,
    handler: async (params, { runtime }) => runtime.getResourceEvidence({ refresh: params.refresh })
  })
]
