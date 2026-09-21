import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { codexHookService } from './hook-service'

type ShellPreflightEnvironment = {
  CODEX_HOME?: string
  ORCA_CODEX_HOME?: string
}

function pathsEqual(left: string, right: string): boolean {
  return (
    normalizeRuntimePathForComparison(resolve(left)) ===
    normalizeRuntimePathForComparison(resolve(right))
  )
}

function realPathMatches(left: string, expectedRealPath: string): boolean {
  try {
    return pathsEqual(realpathSync.native(left), expectedRealPath)
  } catch {
    return false
  }
}

function resolveAccountManagedHome(candidate: string, userDataPath: string): string | null {
  const accountsRoot = join(userDataPath, 'codex-accounts')
  const pathParts = relative(accountsRoot, candidate).split(sep)
  if (pathParts.length !== 2 || !pathParts[0] || pathParts[1] !== 'home') {
    return null
  }
  const accountId = pathParts[0]
  if (accountId === '.' || accountId === '..') {
    return null
  }
  const expectedHome = join(accountsRoot, accountId, 'home')
  let expectedRealHome: string
  try {
    expectedRealHome = join(realpathSync.native(userDataPath), 'codex-accounts', accountId, 'home')
  } catch {
    return null
  }
  if (!pathsEqual(candidate, expectedHome) || !realPathMatches(candidate, expectedRealHome)) {
    return null
  }
  try {
    return readFileSync(join(candidate, '.orca-managed-home'), 'utf-8').trim() === accountId
      ? expectedHome
      : null
  } catch {
    return null
  }
}

export function resolveManagedCodexShellPreflightHome(
  env: ShellPreflightEnvironment,
  userDataPath: string
): string | null {
  const codexHome = env.CODEX_HOME?.trim()
  const orcaCodexHome = env.ORCA_CODEX_HOME?.trim()
  if (!codexHome || !orcaCodexHome || !pathsEqual(codexHome, orcaCodexHome)) {
    return null
  }
  const sharedHome = join(userDataPath, 'codex-runtime-home', 'home')
  if (pathsEqual(codexHome, sharedHome)) {
    let expectedRealHome: string
    try {
      expectedRealHome = join(realpathSync.native(userDataPath), 'codex-runtime-home', 'home')
    } catch {
      return null
    }
    return existsSync(sharedHome) && realPathMatches(codexHome, expectedRealHome)
      ? sharedHome
      : null
  }
  return resolveAccountManagedHome(codexHome, userDataPath)
}

/**
 * Shell-startup preflight for a managed CODEX_HOME.
 *
 * Async because the Codex install awaits an app-server trust-grant session
 * in-process. The old lane forked that session through spawnSync purely to
 * borrow an event loop; the CLI already has one, so awaiting here removes a
 * whole ELECTRON_RUN_AS_NODE process from every managed-home shell launch.
 */
export async function prepareManagedCodexHomeBeforeShellLaunch(args: {
  env?: ShellPreflightEnvironment
  userDataPath: string
  hooksEnabled: boolean
  install?: (runtimeHomePath: string) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
}): Promise<AgentHookInstallStatus | null> {
  if (!args.hooksEnabled) {
    return null
  }
  const env = args.env ?? {
    CODEX_HOME: process.env.CODEX_HOME,
    ORCA_CODEX_HOME: process.env.ORCA_CODEX_HOME
  }
  const runtimeHomePath = resolveManagedCodexShellPreflightHome(env, args.userDataPath)
  if (!runtimeHomePath) {
    return null
  }
  return (args.install ?? ((home) => codexHookService.install(home)))(runtimeHomePath)
}
