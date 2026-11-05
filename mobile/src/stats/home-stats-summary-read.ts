import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'
import type { RpcClient } from '../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
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

// Decorative totals: a refusal keeps the last shown reply.
const homeStatsSummaryRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'stats.home-summary-or-skip',
    method: 'stats.summary',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('home-stats-summary', homeStatsSummarySchema)
  })
)

export type HomeStatsSetter = (
  updater: (previous: Record<string, HomeStatsRow>) => Record<string, HomeStatsRow>
) => void

export function fetchHomeHostStats(
  client: RpcClient,
  hostId: string,
  setStats: HomeStatsSetter,
  disposed: () => boolean
): void {
  homeStatsSummaryRead
    .requestSingleFlight(client, hostId)
    .then((reply) => {
      const summary = homeStatsSummaryRead.interpret(reply)
      if (!disposed() && summary.accepted) {
        setStats((previous) => ({ ...previous, [hostId]: summary.value }))
      }
    })
    .catch(() => {})
}
