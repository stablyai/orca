import {
  captureLoginShellEnvironment,
  resolveLoginShellEnvironment,
  type LoginShellEnvironmentCapture
} from '../startup/login-shell-environment'
import { mergePersistedWindowsPathAsync } from '../pty/windows-environment-path'
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
  resolveLaunchEnv?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnvOverlay?: () => Promise<Record<string, string>> | Record<string, string>
  resolveCodexOverrides?: () => NodeJS.ProcessEnv
}

/**
 * One capture of the host shell environment. Windows loads the PowerShell profile once per
 * process; later refreshes only reread the saved PATH over the last snapshot.
 */
async function captureHostShellEnvironment(
  previous: NodeJS.ProcessEnv | null
): Promise<LoginShellEnvironmentCapture> {
  if (process.platform !== 'win32') {
    // Why: the first capture shares a run a startup reader already began; later ones need a fresh run.
    return captureLoginShellEnvironment({ force: previous !== null })
  }
  const env = { ...(previous ?? process.env) }
  await mergePersistedWindowsPathAsync(env, { forceRefresh: true })
  return previous ? { status: 'captured', env } : captureLoginShellEnvironment({ force: true, env })
}

// Why: long enough that a burst of starts shares one capture, short enough that a CLI
// installed on the host reaches new chats without a restart.
const SHELL_ENVIRONMENT_TTL_MS = 10_000

/**
 * Stale-while-refresh: the first capture starts at creation; later acquisitions get the last
 * snapshot at once and, once it is older than the TTL, refresh it in the background. A capture
 * that fell back to Orca's own env never replaces a snapshot. macOS/Linux retry the shell on the
 * next refresh; Windows loads the profile once, so a failed first PowerShell capture stays until
 * restart, as before.
 */
export function createStructuredAgentEnvironmentResolvers(
  sources: StructuredAgentEnvironmentSources
): {
  resolveCodexEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveClaudeInheritedEnv: () => Promise<Record<string, string>>
  /** The shared base every agent's child env starts from, before its own overlay. */
  resolveBaseEnvironment: () => Promise<Record<string, string>>
} {
  let snapshot: { env: NodeJS.ProcessEnv; capturedAt: number } | null = null
  let pendingEnvironment: Promise<NodeJS.ProcessEnv> | null = null
  const injected = sources.resolveEnvironment
  const capture = injected
    ? async (): Promise<LoginShellEnvironmentCapture> => ({
        status: 'captured',
        env: await injected()
      })
    : captureHostShellEnvironment
  const refresh = (): Promise<NodeJS.ProcessEnv> => {
    pendingEnvironment ??= capture(snapshot?.env ?? null)
      .then((result) => {
        const env = result.status === 'captured' || !snapshot ? result.env : snapshot.env
        snapshot = { env, capturedAt: Date.now() }
        return env
      })
      .finally(() => {
        pendingEnvironment = null
      })
    return pendingEnvironment
  }
  const resolveShellEnvironment = (): Promise<NodeJS.ProcessEnv> => {
    if (!snapshot) {
      return refresh()
    }
    if (Date.now() - snapshot.capturedAt >= SHELL_ENVIRONMENT_TTL_MS) {
      refresh().catch(() => {})
    }
    return Promise.resolve(snapshot.env)
  }
  // Why: start as soon as the runtime exists so the first chat rarely waits for the profile.
  refresh().catch(() => {})
  const resolveBase = async (): Promise<Record<string, string>> =>
    structuredAgentBaseEnvironment({
      shellEnv: await resolveShellEnvironment(),
      policy: sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null)
    })
  return {
    resolveCodexEnvironment: async () => ({
      ...(await resolveBase()),
      ...(await sources.resolveLaunchEnv?.()),
      ...(await sources.resolveLaunchEnvOverlay?.()),
      ...sources.resolveCodexOverrides?.()
    }),
    resolveClaudeInheritedEnv: resolveBase,
    resolveBaseEnvironment: resolveBase
  }
}
