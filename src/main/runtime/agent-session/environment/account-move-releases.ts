import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'

/** The settings a start's account is chosen from; usage and name updates write none of them. */
const SELECTION_KEYS: readonly (keyof GlobalSettings)[] = [
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime'
]

/** A Dispatch settling or the account selection changing can release a chat's held sends; mail
 *  traffic and usage readings cannot. Selection is read from the settings write itself, so a
 *  usage update costs nothing here. */
export function accountMoveReleases(
  dispatches: Pick<CrewChanges, 'subscribe'>,
  settings: () => Pick<RuntimeStore, 'onSettingsChanged' | 'getSettings'> | null,
  openDispatches: NonNullable<StructuredAgentSessionHostDeps['accountMoveWakes']>['openDispatches']
): NonNullable<StructuredAgentSessionHostDeps['accountMoveWakes']> {
  return {
    ...(openDispatches ? { openDispatches } : {}),
    // Pruning a removed account rewrites these without notifying listeners.
    selection: () => {
      const current = settings()?.getSettings()
      return current ? SELECTION_KEYS.map((key) => current[key]) : []
    },
    subscribe: (wake) => {
      const stopDispatches = dispatches.subscribe((facets) => {
        if (facets.has('topology')) {
          wake('dispatch')
        }
      })
      const stopSettings =
        settings()?.onSettingsChanged?.((updates) => {
          if (SELECTION_KEYS.some((key) => key in updates)) {
            wake('account')
          }
        }) ?? (() => {})
      // OpenCode and Devin keep their selection in the data-account service; it changes rarely.
      const stopDataAccounts = hasAppEnvironment()
        ? getManagedDataAccountService().onChanged(() => wake('account'))
        : () => {}
      return () => {
        stopDispatches()
        stopSettings()
        stopDataAccounts()
      }
    }
  }
}
