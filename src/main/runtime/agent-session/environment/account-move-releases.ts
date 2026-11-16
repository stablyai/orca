import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { StructuredAgentSessionAccountMoveEdge } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { AccountsSnapshot, RuntimeAccountController } from './runtime-account-controller'

/** The accounts a start would use; usage and name updates leave it unchanged. */
function selectionKey(snapshot: AccountsSnapshot): string {
  return JSON.stringify([
    snapshot.claude.activeAccountId,
    snapshot.claude.activeAccountIdsByRuntime,
    snapshot.codex.activeAccountId,
    snapshot.codex.activeAccountIdsByRuntime,
    snapshot.opencode?.activeAccountId,
    snapshot.devin?.activeAccountId
  ])
}

/** A Dispatch settling or the account selection changing can release a chat's held sends; mail
 *  traffic and usage readings cannot. */
export function accountMoveReleases(
  dispatches: Pick<CrewChanges, 'subscribe'>,
  accounts: Pick<RuntimeAccountController, 'onChanged'>
): { subscribe: (wake: (edge: StructuredAgentSessionAccountMoveEdge) => void) => () => void } {
  return {
    subscribe: (wake) => {
      const stopDispatches = dispatches.subscribe((facets) => {
        if (facets.has('topology')) {
          wake('dispatch')
        }
      })
      let selection: string | undefined
      let stopAccounts: (() => void) | undefined
      try {
        stopAccounts = accounts.onChanged((snapshot) => {
          const next = selectionKey(snapshot)
          // The first answer has nothing to compare: a switch may be what sent it.
          if (next !== selection) {
            wake('account')
          }
          selection = next
        })
      } catch {
        // A runtime without account services never moves a chat between accounts.
      }
      return () => {
        stopDispatches()
        stopAccounts?.()
      }
    }
  }
}
