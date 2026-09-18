import {
  decodeWorkerListOrderCursor,
  encodeWorkerListOrderCursor
} from '../../../../../../shared/worker-list-order-cursor'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { decodeWorkerListCursor } from './worker-list-cursor'
import type { WorkerListParams } from './worker-release-schemas'

type Params = ReturnType<typeof WorkerListParams.parse>
type Paged = { page: { nextCursor: string | null } }

// Keep the legacy cursor payload intact; old servers reject the v4 envelope instead of reversing its direction.
export async function withWorkerListOrder<T extends Paged>(
  params: Params,
  list: (params: Params) => Promise<T>
) {
  const ordered = params.cursor ? decodeWorkerListOrderCursor(params.cursor) : null
  if (
    ordered &&
    (ordered.run !== (params.run ?? null) ||
      ordered.terminalState !== (params.terminalState ?? null) ||
      (params.order !== undefined && params.order !== ordered.order))
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'A worker-list cursor must keep the same order, Run and terminal-state filter.'
    )
  }
  const order = params.order ?? ordered?.order
  if (order === 'desc' && params.cursor) {
    const inner = ordered ? decodeWorkerListCursor(ordered.cursor) : null
    if (!inner || inner.version === 1) {
      throw new OrchestrationError(
        'invalid_argument',
        'Newest-first listing requires a newest-first cursor. Restart without --cursor.'
      )
    }
  }
  const result = await list({ ...params, order, cursor: ordered?.cursor ?? params.cursor })
  if (order === undefined) {
    return result
  }
  return {
    ...result,
    page: {
      ...result.page,
      order,
      nextCursor:
        order === 'desc' && result.page.nextCursor
          ? encodeWorkerListOrderCursor(params, result.page.nextCursor)
          : result.page.nextCursor
    }
  }
}
