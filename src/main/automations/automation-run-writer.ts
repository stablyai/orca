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
        | 'observeAutomationRunRemovals'
      >
    >,
  publish: PublishAutomationsChanged | null
): AutomationRunWriter {
  const pending = new Map<string, { outcome: AutomationRunOutcome; generation: number }>()
  let disposed = false
  const drain = (generation: number, runId?: string): void => {
    if (disposed || pending.size === 0) {
      return
    }
    const single = runId ? pending.get(runId) : undefined
    const entries = runId ? (single ? [[runId, single] as const] : []) : pending
    for (const [id, intent] of entries) {
      if (intent.generation > generation) {
        continue
      }
      if (!store.hasAutomationRun?.(id)) {
        pending.delete(id)
        continue
      }
      pending.delete(id)
      const selector = store.automationChangeSelector(intent.outcome.run.automationId)
      publish?.({ reason: 'run', ...(selector ? { selector } : {}), settledRun: intent.outcome })
    }
  }
  const unsubscribe = store.onDurableWrite?.(drain)
  const releaseRemovals = store.observeAutomationRunRemovals?.((id) => pending.delete(id))
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
      releaseRemovals?.()
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
        !disposed &&
        mutation &&
        !isFinalAutomationRunStatus(mutation.previousStatus) &&
        (run.status === 'completed' || run.status === 'dispatch_failed')
      ) {
        const automation = mutation.automation
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
        drain(store.automationDurableWriteGeneration?.() ?? 0, run.id)
      }
      await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      drain(store.automationDurableWriteGeneration?.() ?? 0, run.id)
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
