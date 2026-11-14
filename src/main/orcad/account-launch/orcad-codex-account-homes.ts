import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import {
  listGuestCodexAccountHomes,
  resolveGuestCodexAccountHome
} from '../../codex-accounts/managed-homes/guest-codex-account-homes'
import { reconcileCodexAccountHomeHook } from '../../codex/hooks/reconciliation/codex-account-home-hook'
import { stopCodexStateDbBackfillRecoveries } from '../../codex/history/index/codex-state-db-backfill-recovery'
import type { GetSelectedCodexHomePath } from '../../ipc/pty/host-env/types'
import { isWslHostOrcadProcess } from '../../ipc/wsl-guest-windows-drive-path'
import type { BackendServiceCleanup } from '../../backend/service-composition'

/** Keep host status hooks and session discovery in client-selected managed CODEX_HOME paths. */
export function orcadCodexAccountHomes(
  getSettings: () => GlobalSettings,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
) {
  registerCleanup(() => stopCodexStateDbBackfillRecoveries())
  const selectLaunchHome: GetSelectedCodexHomePath = async (_target, launchEnv, context) => {
    // Wire-supplied CODEX_HOME must be managed; user-owned homes are not ours to edit.
    const home = resolveGuestCodexAccountHome(launchEnv?.CODEX_HOME)
    if (!home) {
      return null
    }
    const isEnabled = () => isAgentStatusHooksEnabledForAgent(getSettings(), 'codex')
    // R42, COMPAT(wsl-bridge): the bridge's panes share these homes; off skips until D4 drops it.
    if (isEnabled() || !isWslHostOrcadProcess()) {
      await reconcileCodexAccountHomeHook(home, isEnabled, context?.launchesCodex === true)
    }
    return home
  }
  return {
    selectLaunchHome,
    /** Read selected homes without hook reconciliation for record-less catalogs. */
    readLaunchHome: (launchEnv?: NodeJS.ProcessEnv): string | null =>
      resolveGuestCodexAccountHome(launchEnv?.CODEX_HOME),
    listSessionHomes: (): readonly string[] => listGuestCodexAccountHomes()
  }
}
