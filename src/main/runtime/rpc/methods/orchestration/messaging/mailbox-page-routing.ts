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
