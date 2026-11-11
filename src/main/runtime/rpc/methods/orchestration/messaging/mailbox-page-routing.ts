import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export async function routeAllMailboxPages(
  routePage: () => { routedCount: number; hasMore: boolean },
  signal?: AbortSignal
): Promise<void> {
  while (true) {
    if (signal?.aborted) {
      throw new OrchestrationError('request_aborted', 'Mailbox routing was cancelled.')
    }
    const page = routePage()
    if (!page.hasMore) {
      return
    }
    await yieldToEventLoop()
    if (signal?.aborted) {
      throw new OrchestrationError('request_aborted', 'Mailbox routing was cancelled.')
    }
  }
}

export function createDirectMailSnapshotRouter(db: OrchestrationDb, signal?: AbortSignal) {
  return async (
    runId: string,
    directHandle: string,
    routePage: (throughSequence: number) => { routedCount: number; hasMore: boolean }
  ): Promise<void> => {
    const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
    if (throughSequence !== undefined) {
      await routeAllMailboxPages(() => routePage(throughSequence), signal)
    }
  }
}
