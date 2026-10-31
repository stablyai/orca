import { removeAutomationRunOutputs } from './automation-run-output-files'
import type { Store } from '../persistence'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'

type DurableWrite<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>

export type AutomationRunWriter = {
  createRun: DurableWrite<Store['createAutomationRun']>
  updateRun: DurableWrite<Store['updateAutomationRun']>
  recordReport: DurableWrite<Store['recordAutomationRunReport']>
  repeatSkip: DurableWrite<Store['recordRepeatedAutomationSkip']>
  advanceNextRun: DurableWrite<Store['advanceAutomationNextRun']>
}

/** Publish after durable writes so clients observe progress without an open Automations page. */
export function createAutomationRunWriter(
  store: Pick<
    Store,
    | 'createAutomationRun'
    | 'updateAutomationRun'
    | 'recordAutomationRunReport'
    | 'listAutomationRuns'
    | 'recordRepeatedAutomationSkip'
    | 'advanceAutomationNextRun'
    | 'automationChangeSelector'
    | 'flushPendingOrThrowAsync'
  >,
  publish: PublishAutomationsChanged | null
): AutomationRunWriter {
  // Scope to the run’s host; missing records fall back to an authority-wide event.
  const announce = (automationId: string, reason: 'run' | 'usage'): void => {
    if (!publish) {
      return
    }
    const selector = store.automationChangeSelector(automationId)
    publish({ reason, ...(selector ? { selector } : {}) })
  }
  return {
    advanceNextRun: async (id, now) => {
      const automation = store.advanceAutomationNextRun(id, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return automation
    },
    createRun: async (automation, scheduledFor, trigger): Promise<AutomationRun> => {
      const previous = store.listAutomationRuns()
      const run = store.createAutomationRun(automation, scheduledFor, trigger)
      const retained = new Set(store.listAutomationRuns().map((entry) => entry.id))
      const pruned = previous.filter((entry) => !retained.has(entry.id))
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      removeAutomationRunOutputs(pruned)
      announce(automation.id, 'run')
      return run
    },
    updateRun: async (result: AutomationDispatchResult): Promise<AutomationRun> => {
      const run = store.updateAutomationRun(result)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
    },
    recordReport: async (run, report) => {
      const outcome = store.recordAutomationRunReport(run, report)
      if (outcome.ok) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        announce(run.automationId, 'run')
      }
      return outcome
    },
    repeatSkip: async (automationId, error, scheduledFor): Promise<AutomationRun | null> => {
      const run = store.recordRepeatedAutomationSkip(automationId, error, scheduledFor)
      if (run) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        announce(automationId, 'run')
      }
      return run
    }
  }
}
