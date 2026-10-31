import type { AutomationRunResult, PublishAutomationOutcome } from './automation-run-presentation'
import type {
  AutomationAttentionOwner,
  AutomationAttentionDelivery
} from '../runtime/automation-attention-correlations'
import { readAutomationRunFailure } from '../../shared/automation-run-failure-copy'
import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import type { AutomationRunOutcome } from '../../shared/automation-run-outcome'
import type { Store } from '../persistence'

type DurableWrite<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<ReturnType<T>>

export type AutomationRunWriter = {
  dispose(): void
  createRun: DurableWrite<Store['createAutomationRun']>
  updateRun: (result: AutomationRunResult) => Promise<AutomationRun>
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
  publish: PublishAutomationOutcome | null,
  attentionOwner?: AutomationAttentionOwner
): AutomationRunWriter {
  const pending = new Map<
    string,
    { outcome: AutomationRunOutcome; generation: number; attention?: AutomationAttentionDelivery }
  >()
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
        intent.attention?.release()
        continue
      }
      pending.delete(id)
      const selector = store.automationChangeSelector(intent.outcome.run.automationId)
      try {
        publish?.(
          {
            reason: 'run',
            ...(selector ? { selector } : {}),
            ...(!intent.attention?.covered() ? { settledRun: intent.outcome } : {})
          },
          intent.attention
        )
      } finally {
        intent.attention?.release()
      }
    }
  }
  const unsubscribe = store.onDurableWrite?.(drain)
  const releaseRemovals = store.observeAutomationRunRemovals?.((id) => {
    pending.get(id)?.attention?.release()
    pending.delete(id)
    attentionOwner?.release(id)
  })
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
      for (const intent of pending.values()) {
        intent.attention?.release()
      }
      pending.clear()
      attentionOwner?.dispose()
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
    updateRun: async (result: AutomationRunResult): Promise<AutomationRun> => {
      const mutation = store.updateAutomationRunWithTransition?.(result)
      const run = mutation?.run ?? store.updateAutomationRun(result)
      if (
        !disposed &&
        mutation &&
        !isFinalAutomationRunStatus(mutation.previousStatus) &&
        (run.status === 'completed' || run.status === 'dispatch_failed')
      ) {
        const automation = mutation.automation
        const attention = result.presentation?.attention?.take()
        if (!attention) {
          attentionOwner?.release(run.id)
        }
        const failure = readAutomationRunFailure(run)
        const origin = attention?.origin()
        pending.set(run.id, {
          generation: store.automationWriteGeneration?.() ?? 0,
          attention,
          outcome: {
            name: automation?.name ?? 'Automation',
            agentId: automation?.agentId ?? 'Agent',
            presentation: {
              ...(result.presentation?.assistantMessage
                ? { assistantMessage: result.presentation.assistantMessage }
                : {}),
              ...(failure ? { failure } : {}),
              ...(origin ? { origin } : {})
            },
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
      if (
        mutation &&
        !isFinalAutomationRunStatus(mutation.previousStatus) &&
        isFinalAutomationRunStatus(run.status) &&
        run.status !== 'completed' &&
        run.status !== 'dispatch_failed'
      ) {
        attentionOwner?.release(run.id)
      }
      result.presentation?.attention?.release()
      if (disposed) {
        attentionOwner?.get(run.id)?.abandon()
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
