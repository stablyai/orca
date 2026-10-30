import { isFinalAutomationRunStatus } from '../../shared/automations-types'
import type { AutomationRunOutcome } from '../../shared/automation-run-outcome'
import type { Store } from '../persistence'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'

type DurableWrite<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>

export type AutomationRunWriter = {
  dispose(): void
  createRun: DurableWrite<Store['createAutomationRun']>
  updateRun: DurableWrite<Store['updateAutomationRun']>
  repeatSkip: DurableWrite<Store['recordRepeatedAutomationSkip']>
  advanceNextRun: DurableWrite<Store['advanceAutomationNextRun']>
}

/** Publish after durable writes so clients observe progress without an open Automations page. */
export function createAutomationRunWriter(
  store: Pick<
    Store,
    | 'createAutomationRun'
    | 'updateAutomationRun'
    | 'recordRepeatedAutomationSkip'
    | 'advanceAutomationNextRun'
    | 'automationChangeSelector'
    | 'flushPendingOrThrowAsync'
  > &
    Partial<
      Pick<
        Store,
        | 'updateAutomationRunWithTransition'
        | 'automationWriteGeneration'
        | 'automationDurableWriteGeneration'
        | 'onDurableWrite'
        | 'hasAutomationRun'
        | 'listAutomations'
      >
    >,
  publish: PublishAutomationsChanged | null
): AutomationRunWriter {
  const pending = new Map<string, { outcome: AutomationRunOutcome; generation: number }>()
  let disposed = false
  const drain = (generation: number): void => {
    if (disposed || pending.size === 0) {
      return
    }
    for (const [id, intent] of pending) {
      if (!store.hasAutomationRun?.(id)) {
        pending.delete(id)
        continue
      }
      if (intent.generation > generation) {
        continue
      }
      pending.delete(id)
      const selector = store.automationChangeSelector(intent.outcome.run.automationId)
      publish?.({ reason: 'run', ...(selector ? { selector } : {}), settledRun: intent.outcome })
    }
  }
  const unsubscribe = store.onDurableWrite?.(drain)
  // Scope to the run’s host; missing records fall back to an authority-wide event.
  const announce = (automationId: string, reason: 'run' | 'usage'): void => {
    if (!publish) {
      return
    }
    const selector = store.automationChangeSelector(automationId)
    publish({ reason, ...(selector ? { selector } : {}) })
  }
  return {
    dispose: () => {
      disposed = true
      unsubscribe?.()
      pending.clear()
    },
    advanceNextRun: async (id, now) => {
      const automation = store.advanceAutomationNextRun(id, now)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      return automation
    },
    createRun: async (automation, scheduledFor, trigger): Promise<AutomationRun> => {
      const run = store.createAutomationRun(automation, scheduledFor, trigger)
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      announce(automation.id, 'run')
      return run
    },
    updateRun: async (result: AutomationDispatchResult): Promise<AutomationRun> => {
      const mutation = store.updateAutomationRunWithTransition?.(result)
      const run = mutation?.run ?? store.updateAutomationRun(result)
      if (
        mutation &&
        !isFinalAutomationRunStatus(mutation.previousStatus) &&
        (run.status === 'completed' || run.status === 'dispatch_failed')
      ) {
        const automation = store.listAutomations?.().find((row) => row.id === run.automationId)
        pending.set(run.id, {
          generation: store.automationWriteGeneration?.() ?? 0,
          outcome: {
            name: automation?.name ?? 'Automation',
            agentId: automation?.agentId ?? 'Agent',
            run: {
              id: run.id,
              automationId: run.automationId,
              status: run.status,
              workspaceId: run.workspaceId,
              sessionKind: run.sessionKind,
              chatSessionId: run.chatSessionId,
              terminalPaneKey: run.terminalPaneKey,
              terminalPtyId: run.terminalPtyId,
              dispatchedAt: run.dispatchedAt,
              createdAt: run.createdAt
            }
          }
        })
        // Synchronous authorities may commit before the transition intent is installed.
        drain(store.automationDurableWriteGeneration?.() ?? 0)
      }
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      drain(store.automationDurableWriteGeneration?.() ?? 0)
      announce(run.automationId, result.usage ? 'usage' : 'run')
      return run
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
