import { withOrcaClaudeChatEntrypoint } from '../../../../shared/agent-launch/startup/claude-chat-entrypoint'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  type StructuredAgentCommand,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/structured-agent-command-resolution'
// What a structured Claude child's environment is built from, shared by its launch and the
// `--version` probe that runs the same binary.

import { withCliRuntimeOnPath } from '../../../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { resolveClaudeCommand } from '../../../codex-cli/command'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import { stripInheritedAgentSessionEnv } from '../../../../shared/agent-launch/startup/parent-agent-session-env'
import { overlayEnvironmentVariables } from '../../../../shared/environment-overlay'

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
  operation?: StructuredAgentResolutionOperation
  resolveCommand?: (options?: {
    pathEnv?: string | null
    homePath?: string
  }) => StructuredAgentCommand
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
  prefixArgs: string[]
  overlay: Record<string, string> | undefined
  inheritedEnv: Record<string, string>
}

export function resolveClaudeChildEnvSources(deps: ClaudeEnvDeps): Promise<ClaudeChildEnvSources> {
  return resolveAgainAfterRefreshOnMissingProgram(
    () => readClaudeChildEnvSources(deps),
    deps.refreshEnvironmentAfterMiss,
    {
      env: ({ inheritedEnv, overlay }) =>
        overlayEnvironmentVariables(inheritedEnv, overlay, process.platform),
      cwd: deps.resolveWorkingDirectory,
      signal: deps.signal
    },
    deps.operation
  )
}

async function readClaudeChildEnvSources(deps: ClaudeEnvDeps): Promise<ClaudeChildEnvSources> {
  assertStructuredAgentResolutionCurrent(deps.operation)
  const configured = await waitForPromiseWithSignal(
    Promise.resolve(deps.resolveEnv?.()),
    deps.signal
  )
  const overlay = configured
    ? overlayEnvironmentVariables({}, cloneDefinedEnv(configured), process.platform)
    : undefined
  assertStructuredAgentResolutionCurrent(deps.operation)
  const inheritedEnv = deps.resolveInheritedEnv
    ? await waitForPromiseWithSignal(deps.resolveInheritedEnv(), deps.signal)
    : cloneDefinedEnv(process.env)
  assertStructuredAgentResolutionCurrent(deps.operation)
  deps.signal?.throwIfAborted()
  const effectiveEnv = overlayEnvironmentVariables(inheritedEnv, overlay, process.platform)
  const options = {
    pathEnv: effectiveEnv.PATH ?? effectiveEnv.Path ?? null,
    homePath: effectiveEnv.HOME ?? effectiveEnv.USERPROFILE
  }
  const invocation = deps.resolveCommand
    ? deps.resolveCommand(options)
    : { command: resolveClaudeCommand(options), prefixArgs: [] }
  return { ...invocation, overlay: overlay ? cloneDefinedEnv(overlay) : undefined, inheritedEnv }
}

// Merge onto the shell environment to retain PATH and ambient Anthropic auth.
export function claudeChildEnv(
  sources: ClaudeChildEnvSources,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** False when the session's seal pairs the CLI runtime itself, behind this app's CLI. */
  { runtimeOnPath = true }: { runtimeOnPath?: boolean } = {}
): Record<string, string> {
  const inherited = withoutInheritedClaudeConfigDir(sources.inheritedEnv, process.platform)
  stripInheritedAgentSessionEnv(inherited)
  const env = decorateEnv(overlayEnvironmentVariables(inherited, sources.overlay, process.platform))
  return runtimeOnPath
    ? withCliRuntimeOnPath(sources.command, env, { platform: process.platform })
    : env
}

// Version probes need the launch runtime and PATH, without auth credentials.
export function claudeProbeEnv(sources: ClaudeChildEnvSources): Record<string, string> {
  return withOrcaClaudeChatEntrypoint(
    applyClaudeEnvPatch(
      claudeChildEnv(sources),
      {},
      { stripAuthEnv: true, platform: process.platform }
    ),
    process.platform
  )
}
