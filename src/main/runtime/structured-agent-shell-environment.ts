import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import {
  mergePersistedWindowsPathAsync,
  readPersistedWindowsPathSegmentsAsync
} from '../pty/windows-environment-path'
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

// Why: long enough that a burst of starts shares one capture, short enough that a CLI
// installed on the host reaches new chats without a restart.
const SHELL_ENVIRONMENT_TTL_MS = 10_000

/**
 * This host's shell env, from the shared login-shell cache: the last result at once, rerun in the
 * background past the TTL. Windows keeps a loaded PowerShell profile for good (only a failed load
 * is retried) and lays the saved PATH, where installers add themselves, over it on every read.
 */
async function hostShellEnvironment(cachedOnly = false): Promise<NodeJS.ProcessEnv> {
  const windows = process.platform === 'win32'
  const env = await resolveLoginShellEnvironment({
    cachedOnly,
    refreshAfterMs: SHELL_ENVIRONMENT_TTL_MS,
    keepCaptured: windows
  })
  if (!windows || cachedOnly) {
    return env
  }
  const withSavedPath = { ...env }
  await mergePersistedWindowsPathAsync(withSavedPath)
  return withSavedPath
}

/** For a lookup that started at `askedAt` and found no program: waits for a shell run that started
 *  no earlier (on Windows, a saved PATH reread), so an agent installed before the lookup counts.
 *  The run's own shell timeout bounds the wait. */
export async function refreshHostAgentBaseEnvironmentAfterMiss(askedAt: number): Promise<void> {
  await (
    process.platform === 'win32'
      ? readPersistedWindowsPathSegmentsAsync({ forceRefresh: true, startedAfter: askedAt })
      : resolveLoginShellEnvironment({ startedAfter: askedAt })
  ).catch(() => {})
}

/** Captures this host's shell env again now, so an explicit Refresh never reads a profile kept from
 *  before it (Windows keeps a loaded one for good). */
export async function recaptureHostShellEnvironment(): Promise<void> {
  await refreshAtRestCommandContext(captureHostShellEnvironment)
}

export async function captureHostShellEnvironment(): Promise<void> {
  const startedAfter = Date.now()
  await Promise.all([
    resolveLoginShellEnvironment({ startedAfter }),
    readPersistedWindowsPathSegmentsAsync({ forceRefresh: true, startedAfter })
  ]).catch(() => {})
}

/** The base env every local agent launch on this host starts from, read from current settings. */
export async function resolveHostAgentBaseEnvironment(
  settings: Pick<
    GlobalSettings,
    'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  >
): Promise<Record<string, string>> {
  return structuredAgentBaseEnvironment({
    shellEnv: await hostShellEnvironment(),
    policy: nativeChatShellEnvironmentPolicy(settings)
  })
}

export type StructuredAgentEnvironmentSources = {
  /** Replaces the host's shell env, read once when the resolvers are made; never reread. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveShellEnvironmentPolicy?: () => NativeChatShellEnvironmentPolicy
  /** The user's per-agent environment overlay from settings. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
}

/** Every agent's child env over the host's shell env. Policy and overlays are re-read per
 *  acquisition, so a settings change reaches the next chat without a restart. */
export function createStructuredAgentEnvironmentResolvers(
  sources: StructuredAgentEnvironmentSources
): {
  /** The shared base every agent's child env starts from, before its own overlay. */
  resolveBaseEnvironment: (cachedOnly?: boolean) => Promise<Record<string, string>>
  /** The base with the user's overlay for `agent` laid over it. */
  resolveAgentEnvironment: (agent: string) => Promise<Record<string, string>>
  refreshAfterMissingProgram: (askedAt: number) => Promise<void>
} {
  // Why: start as soon as the runtime exists so the first chat rarely waits for the profile.
  const injected = sources.resolveEnvironment?.()
  const shellEnvironment = injected ? () => injected : hostShellEnvironment
  if (!injected) {
    void hostShellEnvironment().catch(() => {})
  }
  const resolveBase = async (cachedOnly = false): Promise<Record<string, string>> =>
    structuredAgentBaseEnvironment({
      shellEnv: await shellEnvironment(cachedOnly),
      policy: sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null)
    })
  return {
    refreshAfterMissingProgram: injected
      ? async () => {}
      : refreshHostAgentBaseEnvironmentAfterMiss,
    resolveBaseEnvironment: resolveBase,
    resolveAgentEnvironment: async (agent) => ({
      ...(await resolveBase()),
      ...sources.resolveAgentLaunchEnv?.(agent)
    })
  }
}
