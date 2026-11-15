import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../host-screen/catalog/host-list-queries'
import { defineHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { HomeStatsRow } from './home-stats-total'

// An unreadable field decodes as absent so one bad number cannot hide the host's other totals.
const homeStatsSummarySchema = z
  .looseObject({
    totalAgentsSpawned: salvagedOptional('totalAgentsSpawned', z.number()),
    totalPRsCreated: salvagedOptional('totalPRsCreated', z.number()),
    totalAgentTimeMs: salvagedOptional('totalAgentTimeMs', z.number())
  })
  .nullish()
  .catch(undefined)

const homeStatsSummaryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'stats.home-summary-or-skip',
    method: 'stats.summary',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('home-stats-summary', homeStatsSummarySchema)
  })
)

type HomeStats = Exclude<HomeStatsRow, undefined>

export const homeStatsQuery = defineHostQuery<typeof NO_HOST_LIST_INPUT, HomeStats>({
  family: 'stats.summary',
  fetch: async (client, _target, _input, previous, read) => {
    const summary = homeStatsSummaryRead.interpret(await homeStatsSummaryRead.request(client))
    if (summary.accepted) {
      return summary.value ?? null
    }
    // Decorative totals: a refusal keeps the last reply this launch read, never re-dates a stored one.
    if (previous !== undefined && !read.previousFromStore) {
      return previous
    }
    throw new Error('stats.summary unavailable')
  },
  // Re-read each time Home comes back, as before; nothing on the desktop signals new totals.
  staleTime: 0,
  gcTime: Infinity,
  persist: {
    version: 1,
    dataSchema: z
      .looseObject({
        totalAgentsSpawned: z.number().optional(),
        totalPRsCreated: z.number().optional(),
        totalAgentTimeMs: z.number().optional()
      })
      .nullable()
  }
})

export const homeStatsKey = (hostId: string) =>
  hostQueryKey(hostId, homeStatsQuery.family, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)
