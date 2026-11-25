import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { withCodexTerminalServerIsolationEnv } from '../../../../shared/agent-launch/startup/codex-terminal-server-isolation'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getLegacyOpenCodeEnvKeysToDelete } from '../../../opencode/status-hooks/legacy-shared-config-dir'
import { LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS } from '../../../pty/shell-startup/legacy-terminal-shim-dir'
import { PI_PROCESS_OWNER_ENV_KEYS } from '../../../pty/shell-startup/pi-process-owner-env'
import { CODEX_HOME_ENV_KEYS } from '../host-env/codex-home'
import {
  mergePtyEnvDeletions,
  removeCodexHomeDeletionRequests,
  getInheritedAgentHookEnvKeysToDelete,
  getInheritedAgentSessionStampEnvKeysToDelete
} from '../host-env/pi-agent'
import { deleteRequestedEnvKeys } from '../host-env/path'
import {
  canonicalAgentSessionStampEnvKey,
  stripInheritedAgentSessionEnv
} from '../../../../shared/agent-launch/startup/parent-agent-session-env'

/** Carries deletions to provider-owned environments, including persistent older daemons. */
export function assemblePtySpawnEnvDeletions(input: {
  env: Record<string, string> | undefined
  callerEnvToDelete: string[] | undefined
  /** Window only: an Agent Teams refresh drops TERM_PROGRAM; host callers pre-merge their own. */
  agentTeamsEnvToDelete: readonly string[]
  isDaemonHostSpawn: boolean
  connectionId: string | null | undefined
  skipCodexHomeEnv: boolean
  stripInheritedOrcaCodexHome: boolean
  codexResumeHomeSelected: boolean
  settings: GlobalSettings | undefined
}): { env: Record<string, string> | undefined; envToDelete: string[] } {
  // Apply isolation at the common environment boundary used by every provider.
  const isolated = withCodexTerminalServerIsolationEnv(input.env, input.settings)
  const env = isolated ? { ...isolated } : undefined
  if (env) {
    stripInheritedAgentSessionEnv(env, { launchEnv: isolated })
  }
  let envToDelete =
    mergePtyEnvDeletions(
      input.callerEnvToDelete?.map((key) =>
        canonicalAgentSessionStampEnvKey(key, process.platform)
      ) ?? [],
      // Persistent daemons and older SSH hosts must not resurrect a parent Pi's ownership.
      PI_PROCESS_OWNER_ENV_KEYS,
      input.agentTeamsEnvToDelete,
      // Disable legacy hooks on old hosts while preserving ORCA_REAL pointers needed by Windows shims.
      input.isDaemonHostSpawn || input.connectionId ? LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS : [],
      input.isDaemonHostSpawn ? getInheritedAgentHookEnvKeysToDelete(env) : [],
      // The daemon must judge its own inherited value; main may have a different config.
      !input.connectionId && !input.isDaemonHostSpawn
        ? getLegacyOpenCodeEnvKeysToDelete(env, getAppEnvironment().getPath('userData'))
        : [],
      // Local/relay providers also merge ambient env, so remove inherited session stamps on every path.
      getInheritedAgentSessionStampEnvKeysToDelete(env),
      input.skipCodexHomeEnv ? CODEX_HOME_ENV_KEYS : [],
      // Persistent daemons must compare their own merged Codex home markers.
      input.stripInheritedOrcaCodexHome ? ['ORCA_CODEX_HOME'] : []
    ) ?? []
  if (input.codexResumeHomeSelected) {
    envToDelete = removeCodexHomeDeletionRequests(envToDelete) ?? []
  }
  deleteRequestedEnvKeys(env, envToDelete)
  return { env, envToDelete }
}
