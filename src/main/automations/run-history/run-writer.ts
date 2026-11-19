import type { Store } from '../../persistence/loading-store/store'
import type { PublishAutomationsChanged } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import type {
  AutomationDispatchResult,
  AutomationRun
} from '../../../shared/automations/history/automation-run'

type DurableWrite<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>

export type AutomationRunWriter = {
  createRun: DurableWrite<Store['createAutomationRun']>
  updateRun: DurableWrite<Store['updateAutomationRun']>
  repeatSkip: DurableWrite<Store['recordRepeatedAutomationSkip']>
  foldEvent: DurableWrite<Store['foldAutomationEvent']>
  advanceNextRun: DurableWrite<Store['advanceAutomationNextRun']>
}

/** Publish after durable writes so clients observe progress without an open Automations page. */
export function createAutomationRunWriter(
  store: Pick<
    Store,
    | 'createAutomationRun'
    | 'updateAutomationRun'
    | 'recordRepeatedAutomationSkip'
    | 'foldAutomationEvent'
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
  const folded = async (
    automationId: string,
    run: AutomationRun | null
  ): Promise<AutomationRun | null> => {
    if (run) {
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(automationId, 'run')
    }
    return run
  }
  return {
    advanceNextRun: async (id, now) => {
      const automation = store.advanceAutomationNextRun(id, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return automation
    },
    createRun: async (automation, scheduledFor, trigger, event, id): Promise<AutomationRun> => {
      const run = store.createAutomationRun(automation, scheduledFor, trigger, event, id)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(automation.id, 'run')
      return run
    },
    updateRun: async (result: AutomationDispatchResult): Promise<AutomationRun> => {
      const run = store.updateAutomationRun(result)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
    },
    repeatSkip: (automationId, error, scheduledFor, event) =>
      folded(
        automationId,
        store.recordRepeatedAutomationSkip(automationId, error, scheduledFor, event)
      ),
    foldEvent: (automationId, event) =>
      folded(automationId, store.foldAutomationEvent(automationId, event))
  }
}
