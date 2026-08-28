import type { Store } from '../persistence'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'

export type AutomationRunWriter = {
  createRun: Store['createAutomationRun']
  updateRun: Store['updateAutomationRun']
  /** Null when nothing could be folded — the caller then writes an ordinary run. */
  repeatSkip: Store['recordRepeatedAutomationSkip']
}

/** Wraps run persistence so every committed write announces itself. Clients with
 *  the Automations page closed — or none attached at all — have no other way to
 *  learn that a run progressed, so the event must follow the write, not a render. */
export function createAutomationRunWriter(
  store: Store,
  publish: PublishAutomationsChanged | null
): AutomationRunWriter {
  // A run write never moves the record, so its own host is the whole publication.
  // A record that can no longer be named degrades to the authority-wide event.
  const announce = (automationId: string, reason: 'run' | 'usage'): void => {
    if (!publish) {
      return
    }
    const selector = store.automationChangeSelector(automationId)
    publish({ reason, ...(selector ? { selector } : {}) })
  }
  return {
    createRun: (automation, scheduledFor, trigger): AutomationRun => {
      const run = store.createAutomationRun(automation, scheduledFor, trigger)
      announce(automation.id, 'run')
      return run
    },
    updateRun: (result: AutomationDispatchResult): AutomationRun => {
      const run = store.updateAutomationRun(result)
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
    },
    repeatSkip: (automationId, error, scheduledFor): AutomationRun | null => {
      const run = store.recordRepeatedAutomationSkip(automationId, error, scheduledFor)
      if (run) {
        announce(automationId, 'run')
      }
      return run
    }
  }
}
