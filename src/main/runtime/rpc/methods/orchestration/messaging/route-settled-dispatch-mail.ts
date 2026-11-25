import type { MessageType } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { routeAllMailboxPages } from './mailbox-page-routing'

/**
 * Moves a settled Dispatch's unread mail into its owning Run's mailbox and wakes that Run's reader.
 * An aborted check still finishes the move in the background so no page is left half-routed.
 */
export async function routeSettledDispatchMail(
  runtime: Pick<OrcaRuntimeService, 'notifyMessageArrived'>,
  db: Pick<
    OrchestrationDb,
    'getLatestUnreadMessageSequence' | 'routeUnreadDispatchMailboxToRunMailbox'
  >,
  target: { dispatchId: string; runId: string; signal: AbortSignal | undefined }
): Promise<void> {
  const { dispatchId, runId, signal } = target
  const throughSequence = db.getLatestUnreadMessageSequence(`dispatch:${dispatchId}`)
  if (throughSequence === undefined) {
    return
  }
  const routedTypes = new Set<MessageType>()
  const routePage = (): { routedCount: number; hasMore: boolean } => {
    const routed = db.routeUnreadDispatchMailboxToRunMailbox(dispatchId, runId, throughSequence)
    for (const routedType of routed.types) {
      routedTypes.add(routedType)
    }
    return routed
  }
  const notifyRoutedTypes = (): void => {
    for (const routedType of routedTypes) {
      runtime.notifyMessageArrived(`run:${runId}`, routedType)
    }
    routedTypes.clear()
  }
  try {
    await routeAllMailboxPages(routePage, signal)
  } catch (error) {
    notifyRoutedTypes()
    if (error instanceof OrchestrationError && error.code === 'request_aborted') {
      setImmediate(() => {
        void routeAllMailboxPages(routePage)
          .catch(() => undefined)
          .finally(notifyRoutedTypes)
      })
    }
    throw error
  }
  notifyRoutedTypes()
}
