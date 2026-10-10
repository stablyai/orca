// What a structured Claude child's environment is built from, shared by its launch and the
// `--version` probe that runs the same binary.

import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
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
  resolveCommand?: () => string
  resolveEnv?: () =>
    | Promise<Record<string, string> | undefined>
    | Record<string, string>
    | undefined
  /** The env the child inherits before auth stripping; absent inherits Orca's own process env. */
  resolveInheritedEnv?: () => Promise<Record<string, string>>
}

/** What a child's env is built from, before any auth policy applies to it. */
export type ClaudeChildEnvSources = {
  command: string
  overlay: Record<string, string> | undefined
  inheritedEnv: Record<string, string>
}

export async function resolveClaudeChildEnvSources(
  deps: ClaudeEnvDeps
): Promise<ClaudeChildEnvSources> {
  const command = (deps.resolveCommand ?? resolveClaudeCommand)()
  const overlay = await deps.resolveEnv?.()
  const inheritedEnv = deps.resolveInheritedEnv
    ? await deps.resolveInheritedEnv()
    : cloneDefinedEnv(process.env)
  return { command, overlay: overlay ? cloneDefinedEnv(overlay) : undefined, inheritedEnv }
}

// Why the overlay merges onto the inherited env rather than replacing it: the child
// still needs PATH and the rest of the shell environment, and withCliRuntimeOnPath
// derives PATH from what it is handed. The shell's Anthropic auth reaches the child on
// every account, as it does in a terminal.
export function claudeChildEnv(
  sources: ClaudeChildEnvSources,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env,
  /** False when the session's seal pairs the CLI runtime itself, after the session's identity. */
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

/** The env a `--version` probe runs with: the launch's own env, PATH and shims included, minus the
 *  Claude auth variables, auth-like custom headers and an inherited CLAUDE_CONFIG_DIR, which asking
 *  a version needs none of. Everything else is what this same binary receives at launch anyway. */
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
