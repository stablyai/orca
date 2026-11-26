import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionObservedWork } from '../observations/structured-agent-session-observed-work'
import { selectableStructuredSubmission } from './structured-agent-session-input-selection'
import { structuredAgentSessionCommandRunning } from '../operations/structured-agent-session-command-turn'

export function createStructuredDeliveryWake(input: {
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  reconcile: (id: string, journal: AgentSessionJournal) => Promise<void>
  currentWork: (id: string) => Promise<StructuredAgentSessionObservedWork | null>
  wake: (id: string) => void
  logger: StructuredAgentSessionLogger
}): (id: string, journal: AgentSessionJournal) => void {
  const scheduled = new Set<string>()
  return (sessionId, journal) => {
    if (scheduled.has(sessionId)) {
      return
    }
    scheduled.add(sessionId)
    void input
      .serialize(sessionId, async () => {
        scheduled.delete(sessionId)
        await input.reconcile(sessionId, journal)
        const work = await input.currentWork(sessionId)
        if (
          work &&
          !structuredAgentSessionCommandRunning(work) &&
          (await selectableStructuredSubmission(journal, work))
        ) {
          input.wake(sessionId)
        }
      })
      .catch((error: unknown) => {
        scheduled.delete(sessionId)
        input.logger.warn('waking the delivery loop after a commit failed', {
          scope: 'delivery-wake',
          sessionId,
          error
        })
      })
  }
}
