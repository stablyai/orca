import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'

export type CodexShellStartupHomeOverride = {
  home: string
  shell?: string
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
  const effectiveEnv = launchEnv
    ? {
        CODEX_HOME: getLaunchEnvValue(launchEnv, 'CODEX_HOME'),
        ORCA_CODEX_HOME: getLaunchEnvValue(launchEnv, 'ORCA_CODEX_HOME')
      }
    : process.env
  if (hasCustomCodexHomeOverride(effectiveEnv)) {
    return {
      source: 'environment',
      context: { codexHome: effectiveEnv.CODEX_HOME!.trim() }
    }
  }
  const home = launchEnv ? getLaunchEnvValue(launchEnv, 'HOME') : process.env.HOME
  const shell = launchEnv ? getLaunchEnvValue(launchEnv, 'SHELL') : process.env.SHELL
  const shellCodexHome = readShellStartupEnvVar('CODEX_HOME', home, shell)
  if (!home || !shellCodexHome || !hasCustomCodexHomeOverride({ CODEX_HOME: shellCodexHome })) {
    return null
  }
  return {
    source: 'shell-startup',
    context: {
      home,
      ...(shell ? { shell } : {}),
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
  const currentCodexHome = readShellStartupEnvVar(
    'CODEX_HOME',
    currentContext.home,
    currentContext.shell
  )
  return Boolean(
    currentCodexHome &&
    hasCustomCodexHomeOverride({ CODEX_HOME: currentCodexHome }) &&
    normalizePathForComparison(currentCodexHome) === normalizePathForComparison(context.codexHome)
  )
}

export function shellStartupCodexHomeOverrideContextsEqual(
  left: CodexShellStartupHomeOverride,
  right: CodexShellStartupHomeOverride
): boolean {
  return (
    normalizePathForComparison(left.home) === normalizePathForComparison(right.home) &&
    left.shell === right.shell &&
    normalizePathForComparison(left.codexHome) === normalizePathForComparison(right.codexHome)
  )
}

function getLaunchEnvValue(
  launchEnv: NodeJS.ProcessEnv,
  key: 'CODEX_HOME' | 'ORCA_CODEX_HOME' | 'HOME' | 'SHELL'
): string | undefined {
  return Object.prototype.hasOwnProperty.call(launchEnv, key) ? launchEnv[key] : process.env[key]
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
