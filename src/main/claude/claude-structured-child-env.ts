import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveAgainAfterRefreshOnMissingProgram } from '../native-chat/structured-agent-command-resolution'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'

function cloneDefinedEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

export type ClaudeEnvDeps = {
  signal?: AbortSignal
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Refresh once after command lookup misses; absent disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Cwd used to resolve relative PATH entries; defaults to Orca's cwd. */
  resolveWorkingDirectory?: () => Promise<string> | string
  resolveEnv?: () =>
    | Promise<Record<string, string> | undefined>
    | Record<string, string>
    | undefined
  /** Inherited environment before auth policy; defaults to Orca's process environment. */
  resolveInheritedEnv?: () => Promise<Record<string, string>>
}

export type ClaudeChildEnvSources = {
  command: string
  overlay: Record<string, string> | undefined
  inheritedEnv: Record<string, string>
}

export function resolveClaudeChildEnvSources(deps: ClaudeEnvDeps): Promise<ClaudeChildEnvSources> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readClaudeChildEnvSources(deps),
    deps.refreshEnvironmentAfterMiss,
    {
      env: ({ inheritedEnv, overlay }) => ({ ...inheritedEnv, ...overlay }),
      cwd: deps.resolveWorkingDirectory,
      signal: deps.signal
    }
  )
}

async function readClaudeChildEnvSources(deps: ClaudeEnvDeps): Promise<ClaudeChildEnvSources> {
  const overlay = await waitForPromiseWithSignal(Promise.resolve(deps.resolveEnv?.()), deps.signal)
  const inheritedEnv = deps.resolveInheritedEnv
    ? await waitForPromiseWithSignal(deps.resolveInheritedEnv(), deps.signal)
    : cloneDefinedEnv(process.env)
  deps.signal?.throwIfAborted()
  const effectiveEnv = { ...inheritedEnv, ...overlay }
  const command = (deps.resolveCommand ?? resolveClaudeCommand)({
    pathEnv: effectiveEnv.PATH ?? effectiveEnv.Path ?? null,
    homePath: effectiveEnv.HOME ?? effectiveEnv.USERPROFILE
  })
  return { command, overlay: overlay ? cloneDefinedEnv(overlay) : undefined, inheritedEnv }
}

// Merge onto the shell environment to retain PATH and ambient Anthropic auth.
export function claudeChildEnv(
  sources: ClaudeChildEnvSources,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** False when the session's seal pairs the CLI runtime itself, behind this app's CLI. */
  { runtimeOnPath = true }: { runtimeOnPath?: boolean } = {}
): Record<string, string> {
  const env = decorateEnv({
    ...withoutInheritedClaudeConfigDir(sources.inheritedEnv, process.platform),
    ...sources.overlay
  })
  return runtimeOnPath
    ? withCliRuntimeOnPath(sources.command, env, { platform: process.platform })
    : env
}

// Version probes need the launch runtime and PATH, without auth credentials.
export function claudeProbeEnv(sources: ClaudeChildEnvSources): Record<string, string> {
  return applyClaudeEnvPatch(
    claudeChildEnv(sources),
    {},
    {
      stripAuthEnv: true,
      platform: process.platform
    }
  )
}
