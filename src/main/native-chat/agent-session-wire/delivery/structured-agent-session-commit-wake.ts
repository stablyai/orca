import { selectableStructuredSubmission } from './structured-agent-session-input-selection'
import type { hostStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

/** Queue commit wakes under serialization so they cannot race a loop’s stopping decision. */
export function createStructuredAgentSessionCommitWake(input: {
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  deliveryOrder: StructuredAgentSessionDeliveryOrder
  currentWork: (sessionId: string) => ReturnType<typeof hostStructuredAgentSessionCurrentWork>
  wake: (sessionId: string) => unknown
  logger: StructuredAgentSessionHostDeps['logger']
}): (sessionId: string, journal: AgentSessionJournal) => void {
  const wakesQueued = new Set<string>()
  return (sessionId, journal) => {
    if (wakesQueued.has(sessionId)) {
      return
    }
    wakesQueued.add(sessionId)
    void input
      .serialize(sessionId, async () => {
        wakesQueued.delete(sessionId)
        await input.deliveryOrder.reconcile(sessionId, journal)
        const work = await input.currentWork(sessionId)
        if (
          work &&
          !structuredAgentSessionCommandRunning(work) &&
          (await selectableStructuredSubmission(journal, work))
        ) {
          void input.wake(sessionId)
        }
      })
      .catch((error: unknown) => {
        wakesQueued.delete(sessionId)
        input.logger.warn('waking the delivery loop after a commit failed', {
          scope: 'delivery-wake',
          sessionId,
          error
        })
      })
  }
}
