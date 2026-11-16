import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { RuntimeAccountController } from './runtime-account-controller'

/** A Dispatch settling or the account selection changing can release a chat's held sends. */
export function accountMoveReleases(
  dispatches: Pick<CrewChanges, 'subscribe'>,
  accounts: Pick<RuntimeAccountController, 'onChanged'>
): { subscribe: (wake: () => void) => () => void } {
  return {
    subscribe: (wake) => {
      const stopDispatches = dispatches.subscribe(() => wake())
      let stopAccounts: (() => void) | undefined
      try {
        stopAccounts = accounts.onChanged(() => wake())
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
