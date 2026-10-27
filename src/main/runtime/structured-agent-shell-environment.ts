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
} from '../../shared/native-chat/native-chat-shell-environment'

// Even with shell inheritance off, preserve CLI lookup, locale and agent socket.
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

// Share one capture across launch bursts while discovering newly installed CLIs without restart.
const SHELL_ENVIRONMENT_TTL_MS = 10_000

/** Serve cached shell env immediately and refresh after TTL; Windows retains a loaded profile, retrying failures, and overlays saved installer PATH on reads. */
export async function hostShellEnvironment(cachedOnly = false): Promise<NodeJS.ProcessEnv> {
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

/** After a missing-program lookup, await a capture (Windows: saved PATH read) started no earlier than askedAt; the shell timeout bounds it. */
export async function refreshHostAgentBaseEnvironmentAfterMiss(askedAt: number): Promise<void> {
  await (
    process.platform === 'win32'
      ? readPersistedWindowsPathSegmentsAsync({ forceRefresh: true, startedAfter: askedAt })
      : resolveLoginShellEnvironment({ startedAfter: askedAt })
  ).catch(() => {})
}

/** Explicit Refresh must recapture the profile Windows otherwise retains indefinitely. */
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

/** Reread policy and agent overlays on each acquisition so settings changes reach new chats without restart. */
export function createStructuredAgentEnvironmentResolvers(
  sources: StructuredAgentEnvironmentSources
): {
  /** The shared base every agent's child env starts from, before its own overlay. */
  resolveBaseEnvironment: (cachedOnly?: boolean) => Promise<Record<string, string>>
  /** The base with the user's overlay for `agent` laid over it. */
  resolveAgentEnvironment: (agent: string) => Promise<Record<string, string>>
  refreshAfterMissingProgram: (askedAt: number) => Promise<void>
} {
  // Start capture with the runtime so the first chat rarely waits for the shell profile.
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
