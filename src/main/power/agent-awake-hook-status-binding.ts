import { isAgentExecuting } from '../../shared/agent-status/lifecycle/agent-works-behind-question'
import type { AgentHookServer } from '../agent-hooks/server/agent-hook-server'
import type { AgentAwakeService } from './agent-awake-service'

type HookStatusSource = Pick<
  AgentHookServer,
  'getStatusSnapshotForPane' | 'subscribeStatusFreshness' | 'subscribeStatusRowMutations'
>

/** Feeds the keep-awake lease from the hook server's rows. */
export function bindAgentAwakeToHookStatus(
  source: HookStatusSource,
  awake: Pick<AgentAwakeService, 'observeStatusFreshness' | 'updateStatus'>
): () => void {
  const liveRow = (paneKey: string) =>
    source.getStatusSnapshotForPane(paneKey).find((row) => !row.providerSessionOnly)
  const unsubscribeMutations = source.subscribeStatusRowMutations(({ before, after }) => {
    for (const paneKey of new Set([before?.paneKey, after?.paneKey])) {
      if (!paneKey) {
        continue
      }
      const row = liveRow(paneKey)
      awake.updateStatus(
        paneKey,
        row
          ? {
              paneKey,
              state: isAgentExecuting(row) ? 'working' : row.state,
              receivedAt: row.receivedAt,
              observedInCurrentRuntime:
                row.isReplay !== true && row.restoredUnconfirmed !== true && !row.paneSleep
            }
          : undefined
      )
    }
  })
  const unsubscribeFreshness = source.subscribeStatusFreshness((status) => {
    // An observation carries no tool, and renewing a lease with `waiting` releases it.
    const row = status.state === 'waiting' ? liveRow(status.paneKey) : undefined
    awake.observeStatusFreshness(
      row && isAgentExecuting(row) ? { ...status, state: 'working' } : status
    )
  })
  return () => {
    unsubscribeMutations()
    unsubscribeFreshness()
  }
}
