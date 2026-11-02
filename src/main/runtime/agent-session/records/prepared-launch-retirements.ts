import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { matchesPreparedLaunchGeneration } from '../../../../shared/prepared-agent-launch'
import { retirePreparedAgentLaunchInto } from '../ownership/agent-session-operation-admission'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'

type Retirement = Parameters<typeof retirePreparedAgentLaunchInto>[1]
type Waiting = Retirement & PromiseWithResolvers<boolean>

/**
 * Ready retirements share one store draft: every request queued before the store's turn joins the
 * wave. Descriptors are rechecked before drafting, so a wave that is already consumed never drafts,
 * diffs or writes, and each removed descriptor has exactly one winning request.
 */
export function createPreparedLaunchRetirements(
  transactions: Pick<AgentSessionStoreTransactions, 'transactSelected'>
): (args: Retirement) => Promise<boolean> {
  let waiting: Waiting[] = []
  const drain = async (): Promise<void> => {
    let wave: Waiting[] = []
    let winners = new Set<Waiting>()
    try {
      await transactions.transactSelected(
        (state) => {
          ;[wave, waiting] = [waiting, []]
          const keys = new Set<string>()
          for (const request of wave) {
            const key = agentSessionOperationKey(request.callerKey, request.operationId)
            const current = state.operations.get(key)?.preparedLaunch
            if (!keys.has(key) && matchesPreparedLaunchGeneration(current, request)) {
              keys.add(key)
              winners.add(request)
            }
          }
          return winners.size > 0 ? winners : null
        },
        (draft, selected) => {
          for (const request of selected) {
            retirePreparedAgentLaunchInto(draft, request)
          }
        }
      )
    } catch (error) {
      // Nothing was adopted: every descriptor stays for a later observer to retire.
      winners = new Set()
      for (const request of wave) {
        request.reject(error)
      }
      return
    }
    for (const request of wave) {
      request.resolve(winners.has(request))
    }
  }
  return (args) => {
    const request: Waiting = { ...args, ...Promise.withResolvers<boolean>() }
    waiting.push(request)
    if (waiting.length === 1) {
      void drain()
    }
    return request.promise
  }
}
