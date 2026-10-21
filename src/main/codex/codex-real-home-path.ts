import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readBashStartupEnvVar, readShellStartupEnvVar } from '../pty/shell-startup-env'
import { readPowerShellProfileEnvValues } from '../pty/powershell-profile-env'

/** True when the user points Codex outside its standard native home. */
export function hasCustomCodexHomeOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const codexHome = env.CODEX_HOME?.trim()
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim()
  const normalizedCodexHome = codexHome ? normalizePathForComparison(codexHome) : undefined
  const normalizedOrcaCodexHome = orcaCodexHome
    ? normalizePathForComparison(orcaCodexHome)
    : undefined
  // Why: phase 1 owns only ~/.codex and can clean that path on downgrade. A
  // custom home needs cross-home ownership tracking before Orca may mutate it.
  return Boolean(
    normalizedCodexHome &&
    normalizedCodexHome !== normalizedOrcaCodexHome &&
    normalizedCodexHome !== normalizePathForComparison(getSystemCodexHomePath())
  )
}

/** True when the launch env, or a shell startup file it reads, points Codex at a custom home. */
export function hasCustomCodexHomeOverrideForLaunch(launchEnv?: NodeJS.ProcessEnv): boolean {
  if (
    hasCustomCodexHomeOverride({
      CODEX_HOME: getLaunchEnvValue(launchEnv, 'CODEX_HOME'),
      ORCA_CODEX_HOME: getLaunchEnvValue(launchEnv, 'ORCA_CODEX_HOME')
    })
  ) {
    return true
  }
  // Why USERPROFILE: Windows has no HOME, and PowerShell profiles hang off it.
  const home = getLaunchEnvValue(launchEnv, process.platform === 'win32' ? 'USERPROFILE' : 'HOME')
  if (!home) {
    return false
  }
  // Why: a Windows pane may run either PowerShell edition or Git Bash, so any of their
  // startup files counts.
  const shellCodexHomes =
    process.platform === 'win32'
      ? [
          ...readPowerShellProfileEnvValues('CODEX_HOME', home),
          readBashStartupEnvVar('CODEX_HOME', home)
        ]
      : [
          readShellStartupEnvVar(
            'CODEX_HOME',
            home,
            getLaunchEnvValue(launchEnv, 'SHELL'),
            getLaunchEnvValue(launchEnv, 'XDG_CONFIG_HOME')
          )
        ]
  return shellCodexHomes.some(
    (codexHome) => codexHome !== undefined && hasCustomCodexHomeOverride({ CODEX_HOME: codexHome })
  )
}

type LaunchEnvKey =
  | 'CODEX_HOME'
  | 'ORCA_CODEX_HOME'
  | 'HOME'
  | 'USERPROFILE'
  | 'SHELL'
  | 'XDG_CONFIG_HOME'

function getLaunchEnvValue(
  launchEnv: NodeJS.ProcessEnv | undefined,
  key: LaunchEnvKey
): string | undefined {
  return launchEnv && Object.hasOwn(launchEnv, key) ? launchEnv[key] : process.env[key]
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
