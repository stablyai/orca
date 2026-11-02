import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readBashStartupEnvVar, readShellStartupEnvVar } from '../../../pty/shell-startup-env'
import { readPowerShellProfileEnvValues } from '../../../pty/powershell-profile-env'

export type SavedResumeStoreQuery = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  /** What the agent launches with: this host's env, the spawn's env, minus its deletions. */
  launchEnv: NodeJS.ProcessEnv
  cwd: string | undefined
  /** Codex home after account routing; `verified` means routing found the rollout there. */
  codexHome: { selected: string | null; verified: boolean }
  recipeArgs: string
  settings:
    | Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts' | 'codexManagedAccounts'>
    | undefined
}

/** Whether a shell startup file assigns `key`, which would point the agent at another store. */
export function shellStartupAssigns(key: string, env: NodeJS.ProcessEnv): boolean {
  const home = env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']
  if (!home) {
    return true
  }
  return process.platform === 'win32'
    ? readPowerShellProfileEnvValues(key, home).length > 0 ||
        readBashStartupEnvVar(key, home) !== undefined
    : readShellStartupEnvVar(key, home, env.SHELL, env.XDG_CONFIG_HOME) !== undefined
}
