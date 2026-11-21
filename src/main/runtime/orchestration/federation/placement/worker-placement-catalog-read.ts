import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import type { RuntimeRequestGuard } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  readPlacementCatalogList,
  reducePlacementCatalog,
  type WorkerPlacementCatalog,
  type CatalogReadFailure
} from './worker-placement-catalog'

export type WorkerPlacementCatalogRead =
  | { kind: 'complete'; catalog: WorkerPlacementCatalog }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: CatalogReadFailure }

export async function readWorkerPlacementCatalog(
  transport: OrchestrationEnvironmentTransport,
  server: OrchestrationWorkerServer,
  prepareGuard: RuntimeRequestGuard
): Promise<WorkerPlacementCatalogRead> {
  const replies = await Promise.all(
    (['repos', 'setups'] as const).map(async (key) => {
      try {
        const response = await transport.call(
          server.environmentId,
          key === 'repos' ? 'repo.list' : 'projectHostSetup.list',
          {},
          15_000,
          undefined,
          server.pairingRevision,
          { prepareGuard }
        )
        if (!response.ok) {
          return key === 'setups' &&
            ['method_not_found', 'incompatible_runtime'].includes(response.error.code)
            ? { kind: 'unsupported' as const }
            : { kind: 'failed' as const, reason: 'incomplete' as const }
        }
        const result = readPlacementCatalogList(response.result, key)
        return result.ok
          ? { kind: 'rows' as const, rows: result.rows, runtimeId: response._meta?.runtimeId }
          : { kind: 'failed' as const, reason: result.reason }
      } catch {
        return { kind: 'failed' as const, reason: 'no_answer' as const }
      }
    })
  )
  const [repos, setups] = replies
  if (setups.kind === 'unsupported') {
    return { kind: 'unsupported' }
  }
  const catalog =
    repos.kind === 'rows' &&
    setups.kind === 'rows' &&
    repos.runtimeId === setups.runtimeId &&
    repos.runtimeId?.trim()
      ? reducePlacementCatalog(repos.rows, setups.rows)
      : null
  if (catalog) {
    return { kind: 'complete', catalog }
  }
  const failures = replies.flatMap((reply) => (reply.kind === 'failed' ? [reply.reason] : []))
  const reason = failures.includes('oversized')
    ? 'oversized'
    : failures.length === 2 && failures.every((reason) => reason === 'no_answer')
      ? 'no_answer'
      : 'incomplete'
  return { kind: 'failed', reason }
}
