import type { CrewChanges } from '../../orchestration/crew/crew-changes'
import type { StructuredAgentSessionHostDeps } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'

/** The settings a start's account is chosen from, including the launch environment a System-default
 *  home comes from (CLAUDE_CONFIG_DIR, CODEX_HOME); usage and name updates write none of them. */
const SELECTION_KEYS: readonly (keyof GlobalSettings)[] = [
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'agentDefaultEnv',
  'nativeChatInheritShellEnvironment',
  'nativeChatShellEnvironmentVariables'
]

/** A Dispatch settling or the account selection changing can release a chat's held sends; mail
 *  traffic and usage readings cannot. Each names what changed: the Dispatch ends the database
 *  recorded, and the selection keys of the settings write, so other changes cost nothing here. */
export function accountMoveReleases(
  dispatches: Pick<CrewChanges, 'subscribe'>,
  settings: () => Pick<RuntimeStore, 'onSettingsChanged' | 'getSettings'> | null,
  dispatchEnds: {
    /** Starts recording ends; earlier ones are not reported. */
    watch: () => void
    /** The keys whose Dispatch work ended since the last call. */
    take: () => readonly string[]
    key: (sessionId: string) => string
  }
): NonNullable<StructuredAgentSessionHostDeps['accountMoveWakes']> {
  return {
    dispatchKey: dispatchEnds.key,
    // Pruning a removed account rewrites these without notifying listeners.
    selection: () => {
      const current = settings()?.getSettings()
      return current ? SELECTION_KEYS.map((key) => current[key]) : []
    },
    subscribe: (wake) => {
      dispatchEnds.watch()
      const stopDispatches = dispatches.subscribe((facets) => {
        const ended = facets.has('topology') ? dispatchEnds.take() : []
        if (ended.length > 0) {
          wake({ kind: 'dispatch', ended })
        }
      })
      const stopSettings =
        settings()?.onSettingsChanged?.((updates) => {
          // The store lists only keys whose value changed.
          if (SELECTION_KEYS.some((key) => key in updates)) {
            wake({ kind: 'account' })
          }
        }) ?? (() => {})
      // Other agent types keep their selection in the data-account service; it changes rarely.
      const stopDataAccounts = hasAppEnvironment()
        ? getManagedDataAccountService().onChanged(() => wake({ kind: 'account' }))
        : () => {}
      return () => {
        stopDispatches()
        stopSettings()
        stopDataAccounts()
      }
    }
  }
}
