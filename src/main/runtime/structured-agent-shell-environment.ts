import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  nativeChatShellEnvironmentPolicy,
  type NativeChatShellEnvironmentPolicy
} from '../../shared/native-chat-shell-environment'

// Why: with the whole shell off, the child must still find its CLI and keep locale and agent socket.
const BASELINE_SHELL_VARIABLES = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK']

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      defined[key] = value
    }
  }
  return defined
}

/** Overlays shell variables on Orca's env; win32 names are case-insensitive, so drop the base spelling. */
function overlayShellVariables(
  base: Record<string, string>,
  shellVariables: Record<string, string>,
  platform: NodeJS.Platform
): Record<string, string> {
  const merged = { ...base }
  if (platform === 'win32') {
    const overlaid = new Set(Object.keys(shellVariables).map((key) => key.toUpperCase()))
    for (const key of Object.keys(merged)) {
      if (overlaid.has(key.toUpperCase())) {
        delete merged[key]
      }
    }
  }
  return { ...merged, ...shellVariables }
}

function pickShellVariables(
  shellEnv: NodeJS.ProcessEnv,
  names: readonly string[],
  platform: NodeJS.Platform
): Record<string, string> {
  const normalize = (key: string): string => (platform === 'win32' ? key.toUpperCase() : key)
  const allowed = new Set([...BASELINE_SHELL_VARIABLES, ...names].map(normalize))
  const picked: Record<string, string> = {}
  for (const [key, value] of Object.entries(definedEnv(shellEnv))) {
    if (allowed.has(normalize(key))) {
      picked[key] = value
    }
  }
  return picked
}

/**
 * The env every structured chat child starts from, before its provider pins an account.
 * Inheriting everything is the login-shell snapshot as-is; otherwise Orca's own env plus
 * the baseline and listed shell variables.
 */
export function structuredAgentBaseEnvironment(input: {
  shellEnv: NodeJS.ProcessEnv
  policy: NativeChatShellEnvironmentPolicy
  processEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Record<string, string> {
  if (input.policy.inheritAll) {
    return definedEnv(input.shellEnv)
  }
  const platform = input.platform ?? process.platform
  return overlayShellVariables(
    definedEnv(input.processEnv ?? process.env),
    pickShellVariables(input.shellEnv, input.policy.names, platform),
    platform
  )
}

/** The base env every local agent launch on this host starts from, read from current settings. */
export async function resolveHostAgentBaseEnvironment(
  settings: Pick<
    GlobalSettings,
    'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  >
): Promise<Record<string, string>> {
  return structuredAgentBaseEnvironment({
    shellEnv: await resolveLoginShellEnvironment(),
    policy: nativeChatShellEnvironmentPolicy(settings)
  })
}

export type StructuredAgentEnvironmentSources = {
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  /** The user's per-agent environment overlay from settings. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
}

/**
 * Every agent's child env over one login-shell snapshot, taken once at install.
 * The policy and overlays are re-read per acquisition, so a settings change reaches
 * the next chat without a restart.
 */
export function createStructuredAgentEnvironmentResolvers(
  sources: StructuredAgentEnvironmentSources
): {
  /** The shared base every agent's child env starts from, before its own overlay. */
  resolveBaseEnvironment: () => Promise<Record<string, string>>
  /** The base with the user's overlay for `agent` laid over it. */
  resolveAgentEnvironment: (agent: string) => Promise<Record<string, string>>
} {
  const shellEnvironment = (sources.resolveEnvironment ?? resolveLoginShellEnvironment)()
  const resolveBase = async (): Promise<Record<string, string>> =>
    structuredAgentBaseEnvironment({
      shellEnv: await shellEnvironment,
      policy: sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null)
    })
  return {
    resolveBaseEnvironment: resolveBase,
    resolveAgentEnvironment: async (agent) => ({
      ...(await resolveBase()),
      ...sources.resolveAgentLaunchEnv?.(agent)
    })
  }
}
