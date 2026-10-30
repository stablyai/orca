import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import {
  cachedPersistedWindowsPathSegments,
  mergePersistedWindowsPathAsync,
  readPersistedWindowsPathSegmentsAsync
} from '../pty/windows-environment-path'
import { mergeWindowsPathSegments, resolvePathEnvKey } from '../pty/windows-path-segment-merge'
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
  if (!windows) {
    return env
  }
  const withSavedPath = { ...env }
  if (cachedOnly) {
    mergeWindowsPathSegments(
      withSavedPath,
      cachedPersistedWindowsPathSegments(),
      process.platform,
      process.env
    )
  } else {
    await mergePersistedWindowsPathAsync(withSavedPath)
  }
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
  await refreshAtRestCommandContext(() => captureHostShellEnvironment())
}

type EnvironmentProjection = (shellEnv: NodeJS.ProcessEnv) => Map<string, string>
const servingEnvironmentCaptures = new Set<() => EnvironmentProjection>()

export function captureHostShellEnvironment(): Promise<void>
export function captureHostShellEnvironment<T>(beforeCapture: () => Promise<T>): Promise<T>
export async function captureHostShellEnvironment<T>(
  beforeCapture?: () => Promise<T>
): Promise<T | undefined> {
  const cachedShell = resolveLoginShellEnvironment({ cachedOnly: true })
  const cachedPath = cachedPersistedWindowsPathSegments()
  const comparisons = [...servingEnvironmentCaptures].map((capture) => ({
    capture,
    project: capture()
  }))
  const before = { ...(await cachedShell) }
  if (process.platform === 'win32') {
    mergeWindowsPathSegments(before, cachedPath, process.platform, process.env)
  }
  const previous = comparisons.map(({ project }) => project(before))
  try {
    return await beforeCapture?.()
  } finally {
    const startedAfter = Date.now()
    await Promise.all([
      resolveLoginShellEnvironment({ startedAfter }),
      readPersistedWindowsPathSegmentsAsync({ forceRefresh: true, startedAfter })
    ]).catch(() => {})
    const after = { ...(await resolveLoginShellEnvironment({ cachedOnly: true })) }
    if (process.platform === 'win32') {
      mergeWindowsPathSegments(
        after,
        cachedPersistedWindowsPathSegments(),
        process.platform,
        process.env
      )
    }
    comparisons.forEach(({ capture }, index) => {
      if (!servingEnvironmentCaptures.has(capture)) {
        return
      }
      const next = capture()(after)
      agentModelCatalogStore.expireLaunchScopes(
        (agent) => previous[index].has(agent) && previous[index].get(agent) !== next.get(agent)
      )
    })
  }
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
  prewarm?: boolean
  processEnvironment?: NodeJS.ProcessEnv
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
  bindCatalogSources: (agents: readonly string[]) => () => void
} {
  // Start capture with the runtime so the first chat rarely waits for the shell profile.
  const injected = sources.resolveEnvironment?.()
  const shellEnvironment = injected ? () => injected : hostShellEnvironment
  if (!injected && sources.prewarm !== false) {
    void hostShellEnvironment().catch(() => {})
  }
  const resolveBase = async (cachedOnly = false): Promise<Record<string, string>> =>
    structuredAgentBaseEnvironment({
      shellEnv: await shellEnvironment(cachedOnly),
      policy: sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null),
      processEnv: sources.processEnvironment
    })
  return {
    refreshAfterMissingProgram: injected
      ? async () => {}
      : refreshHostAgentBaseEnvironmentAfterMiss,
    bindCatalogSources: (agents) => {
      if (injected) {
        return () => {}
      }
      const capture = (): EnvironmentProjection => {
        const selectedPolicy =
          sources.resolveShellEnvironmentPolicy?.() ?? nativeChatShellEnvironmentPolicy(null)
        const policy = { ...selectedPolicy, names: [...selectedPolicy.names] }
        const processEnv = { ...(sources.processEnvironment ?? process.env) }
        const overlays = new Map(
          agents.map((agent) => [agent, { ...sources.resolveAgentLaunchEnv?.(agent) }])
        )
        return (shellEnv) => {
          const base = structuredAgentBaseEnvironment({ shellEnv, policy, processEnv })
          return new Map(
            agents.map((agent) => {
              const effective = { ...base, ...overlays.get(agent) }
              return [agent, structuredAgentEnvironmentIdentity(effective)]
            })
          )
        }
      }
      servingEnvironmentCaptures.add(capture)
      return () => {
        servingEnvironmentCaptures.delete(capture)
      }
    },
    resolveBaseEnvironment: resolveBase,
    resolveAgentEnvironment: async (agent) => ({
      ...(await resolveBase()),
      ...sources.resolveAgentLaunchEnv?.(agent)
    })
  }
}

/** Compare the environment block the launcher reads, including Windows' first matching key. */
export function structuredAgentEnvironmentIdentity(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string {
  const effective = new Map<string, string>()
  const pathKey = resolvePathEnvKey(env, platform)
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue
    }
    const name = platform === 'win32' ? key.toUpperCase() : key
    if (platform === 'win32' && name === 'PATH' && key !== pathKey) {
      continue
    }
    if (!effective.has(name)) {
      effective.set(name, value)
    }
  }
  return JSON.stringify([...effective].sort(([a], [b]) => a.localeCompare(b)))
}
