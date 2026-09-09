import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'

const ResourceStatusParams = z.object({
  // Why: default off — the command returns the cached poll snapshot; refresh
  // opts into the stale-aware provider fetch (poll throttle and Retry-After still apply).
  refresh: z.boolean().default(false)
})

export const RESOURCE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'resource.status',
    params: ResourceStatusParams,
    handler: async (params, { runtime }) => runtime.getResourceEvidence({ refresh: params.refresh })
  })
]
