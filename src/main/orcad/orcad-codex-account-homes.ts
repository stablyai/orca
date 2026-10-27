import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import {
  listGuestCodexAccountHomes,
  resolveGuestCodexAccountHome
} from '../codex-accounts/guest-codex-account-homes'
import { reconcileCodexAccountHomeHook } from '../codex/codex-account-home-hook'
import { stopCodexStateDbBackfillRecoveries } from '../codex/codex-state-db-backfill-recovery'
import type { GetSelectedCodexHomePath } from '../ipc/pty/host-env/types'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** Keep host status hooks and session discovery in client-selected managed CODEX_HOME paths. */
export function orcadCodexAccountHomes(
  getSettings: () => GlobalSettings,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
) {
  registerCleanup(() => stopCodexStateDbBackfillRecoveries())
  const selectLaunchHome: GetSelectedCodexHomePath = async (_target, launchEnv, context) => {
    // Wire-supplied CODEX_HOME must be managed; user-owned homes are not ours to edit.
    const home = resolveGuestCodexAccountHome(launchEnv?.CODEX_HOME)
    if (!home) {
      return null
    }
    await reconcileCodexAccountHomeHook(
      home,
      () => isAgentStatusHooksEnabledForAgent(getSettings(), 'codex'),
      context?.launchesCodex === true
    )
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
