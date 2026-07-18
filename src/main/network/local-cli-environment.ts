import {
  buildConfiguredProxyEnv,
  NETWORK_PROXY_ENV_KEYS,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import { mergePersistedWindowsPath } from '../pty/windows-environment-path'
import {
  hydrateShellPath,
  mergePathSegments,
  type HydrationResult
} from '../startup/hydrate-shell-path'

let configuredProxySettings: NetworkProxySettings | null = null

/**
 * Replace the proxy settings used by app-owned local CLI subprocesses.
 *
 * @param settings Current persisted Orca proxy settings.
 */
export function setLocalCliProxySettings(settings: NetworkProxySettings | null | undefined): void {
  configuredProxySettings = settings
    ? {
        httpProxyUrl: settings.httpProxyUrl,
        httpProxyBypassRules: settings.httpProxyBypassRules
      }
    : null
}

/**
 * Reset process-wide proxy settings retained by this module.
 *
 * @internal Tests use this to keep module state isolated.
 */
export function _resetLocalCliProxySettings(): void {
  configuredProxySettings = null
}

/**
 * Copy only string-valued process environment entries.
 *
 * @param env Environment to sanitize for child_process.
 * @returns A mutable environment record without undefined values.
 */
function stringOnlyEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

/**
 * Fill missing proxy variables from the user's login shell snapshot.
 *
 * @param env Mutable child-process environment.
 * @param shellHydration Cached shell hydration result.
 */
function fillShellProxyEnvironment(
  env: Record<string, string>,
  shellHydration: HydrationResult
): void {
  for (const key of NETWORK_PROXY_ENV_KEYS) {
    const value = shellHydration.proxyEnv[key]
    if (env[key] === undefined && value !== undefined) {
      env[key] = value
    }
  }
}

/**
 * Build the environment for a CLI that executes on the local host.
 *
 * @param baseEnv Caller-specific environment, defaulting to the Orca process.
 * @returns Environment with shell proxy fallback and authoritative Orca proxy settings.
 */
export async function buildLocalCliEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  if (process.platform === 'win32') {
    const env = stringOnlyEnvironment(baseEnv)
    mergePersistedWindowsPath(env)
    Object.assign(env, buildConfiguredProxyEnv(configuredProxySettings))
    return env
  }

  const shellHydration = await hydrateShellPath()
  // Why: the startup hydration callback can finish while this function awaits
  // the same promise. Merge before copying so GUI-launched probes do not retain
  // the sparse PATH snapshot from before shell startup completed.
  if (baseEnv === process.env && shellHydration.segments.length > 0) {
    mergePathSegments(shellHydration.segments)
  }
  const env = stringOnlyEnvironment(baseEnv)
  fillShellProxyEnvironment(env, shellHydration)

  // Why: a manual Orca proxy is the child-process source of truth. Applying it
  // last also clears inherited NO_PROXY through buildConfiguredProxyEnv.
  Object.assign(env, buildConfiguredProxyEnv(configuredProxySettings))
  return env
}
