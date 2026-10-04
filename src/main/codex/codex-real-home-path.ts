import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readBashStartupEnvVar, readShellStartupEnvVar } from '../pty/shell-startup-env'
import { readPowerShellProfileEnvValues } from '../pty/powershell-profile-env'

export type CodexShellStartupHomeOverride = {
  home: string
  shell?: string
  /** Why recorded: fish reads config under it, so re-reads must use the same root. */
  configHome?: string
  codexHome: string
}

export type CodexEnvironmentHomeOverride = {
  codexHome: string
}

export type CustomCodexHomeOverrideForLaunch =
  | { source: 'environment'; context: CodexEnvironmentHomeOverride }
  | { source: 'shell-startup'; context: CodexShellStartupHomeOverride }

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

export function hasCustomCodexHomeOverrideForLaunch(launchEnv?: NodeJS.ProcessEnv): boolean {
  return getCustomCodexHomeOverrideForLaunch(launchEnv) !== null
}

export function getCustomCodexHomeOverrideForLaunch(
  launchEnv?: NodeJS.ProcessEnv
): CustomCodexHomeOverrideForLaunch | null {
  const effectiveEnv = {
    CODEX_HOME: getLaunchEnvValue(launchEnv, 'CODEX_HOME'),
    ORCA_CODEX_HOME: getLaunchEnvValue(launchEnv, 'ORCA_CODEX_HOME')
  }
  if (hasCustomCodexHomeOverride(effectiveEnv)) {
    return {
      source: 'environment',
      context: { codexHome: effectiveEnv.CODEX_HOME!.trim() }
    }
  }
  // Why USERPROFILE: Windows has no HOME, and PowerShell profiles hang off it.
  const home = getLaunchEnvValue(launchEnv, process.platform === 'win32' ? 'USERPROFILE' : 'HOME')
  const shell = getLaunchEnvValue(launchEnv, 'SHELL')
  const configHome = getLaunchEnvValue(launchEnv, 'XDG_CONFIG_HOME')
  const [shellCodexHome] = readCustomShellStartupCodexHomes(home, shell, configHome)
  if (!home || !shellCodexHome) {
    return null
  }
  return {
    source: 'shell-startup',
    context: {
      home,
      ...(shell ? { shell } : {}),
      ...(configHome ? { configHome } : {}),
      codexHome: shellCodexHome
    }
  }
}

export function environmentCodexHomeOverrideContextsEqual(
  left: CodexEnvironmentHomeOverride,
  right: CodexEnvironmentHomeOverride
): boolean {
  return normalizePathForComparison(left.codexHome) === normalizePathForComparison(right.codexHome)
}

export function shellStartupCodexHomeOverrideMatches(
  context: CodexShellStartupHomeOverride,
  currentContext: CodexShellStartupHomeOverride = context
): boolean {
  if (!shellStartupCodexHomeOverrideContextsEqual(context, currentContext)) {
    return false
  }
  return readCustomShellStartupCodexHomes(
    currentContext.home,
    currentContext.shell,
    currentContext.configHome
  ).some(
    (codexHome) =>
      normalizePathForComparison(codexHome) === normalizePathForComparison(context.codexHome)
  )
}

export function shellStartupCodexHomeOverrideContextsEqual(
  left: CodexShellStartupHomeOverride,
  right: CodexShellStartupHomeOverride
): boolean {
  return (
    normalizePathForComparison(left.home) === normalizePathForComparison(right.home) &&
    left.shell === right.shell &&
    left.configHome === right.configHome &&
    normalizePathForComparison(left.codexHome) === normalizePathForComparison(right.codexHome)
  )
}

/**
 * Custom CODEX_HOMEs the pane's shell startup may set. A Windows pane may run
 * either PowerShell edition or Git Bash, so any of their startup files counts.
 */
function readCustomShellStartupCodexHomes(
  home: string | undefined,
  shell: string | undefined,
  configHome: string | undefined
): string[] {
  if (!home) {
    return []
  }
  const candidates =
    process.platform === 'win32'
      ? [
          ...readPowerShellProfileEnvValues('CODEX_HOME', home),
          readBashStartupEnvVar('CODEX_HOME', home)
        ]
      : [readShellStartupEnvVar('CODEX_HOME', home, shell, configHome)]
  return candidates.filter(
    (codexHome): codexHome is string =>
      codexHome !== undefined && hasCustomCodexHomeOverride({ CODEX_HOME: codexHome })
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
