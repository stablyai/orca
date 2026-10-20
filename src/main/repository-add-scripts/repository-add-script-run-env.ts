import { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } from '../../shared/terminal-git-credential-guard'
import { promptGuardShellEnv } from '../git/runner'
import { dropIncoherentCondaActivationEnv } from '../pty/conda-activation-env'
import { SETUP_RUNNER_PATH_ENV_KEYS, getSetupRunnerEnvVars } from '../setup-hook-env-vars'
import { toLinuxPath } from '../wsl'
import type { RepositoryAddScriptRun } from './repository-add-script-service'

function buildRunEnv(run: RepositoryAddScriptRun): Record<string, string> {
  // Only path/id fields are read by the env builder.
  return getSetupRunnerEnvVars(
    { id: run.repoId, path: run.path, displayName: '', badgeColor: '', addedAt: 0 },
    run.path
  )
}

export function buildNativeEnv(
  run: RepositoryAddScriptRun,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...buildRunEnv(run) }
  dropIncoherentCondaActivationEnv(env, platform)
  return promptGuardShellEnv(env)
}

export function buildWslGuestEnv(run: RepositoryAddScriptRun): Record<string, string> {
  const guestEnv: Record<string, string> = {}
  const pathKeys: readonly string[] = SETUP_RUNNER_PATH_ENV_KEYS
  for (const [key, value] of Object.entries(buildRunEnv(run))) {
    guestEnv[key] = pathKeys.includes(key) ? toLinuxPath(value) : value
  }
  // Same unattended-git guard as hooks: only the guard flags reach the guest.
  for (const [key, value] of Object.entries(promptGuardShellEnv(guestEnv))) {
    if (
      value !== undefined &&
      (key === 'GIT_TERMINAL_PROMPT' ||
        key === 'GCM_INTERACTIVE' ||
        key === TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV ||
        key.startsWith('GIT_CONFIG_'))
    ) {
      guestEnv[key] = value
    }
  }
  return guestEnv
}
