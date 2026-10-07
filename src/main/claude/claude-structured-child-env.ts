// What a structured Claude child's environment is built from, shared by its launch and the
// `--version` probe that runs the same binary.

import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveClaudeCommand } from '../codex-cli/command'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import type { ClaudeStructuredLaunchResolverDeps } from './claude-structured-launch-resolution'

function cloneDefinedEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

export type ClaudeEnvDeps = Pick<
  ClaudeStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnv' | 'resolveInheritedEnv'
>

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
// derives PATH from what it is handed. Ambient Anthropic auth is stripped from the
// inherited half only when a managed account owns the credential; a system-auth
// user's own key is their sign-in and must reach the child.
export function claudeChildEnv(
  sources: ClaudeChildEnvSources,
  stripAuthEnv: boolean,
  decorateEnv: (env: Record<string, string>) => Record<string, string> = (env) => env
): Record<string, string> {
  return withCliRuntimeOnPath(
    sources.command,
    decorateEnv({
      ...applyClaudeEnvPatch(
        withoutInheritedClaudeConfigDir(sources.inheritedEnv, process.platform),
        {},
        { stripAuthEnv, platform: process.platform }
      ),
      ...sources.overlay
    }),
    { platform: process.platform }
  )
}

/** The env a `--version` probe runs with: the launch's own env, PATH and shims included, minus the
 *  Claude auth variables, auth-like custom headers and an inherited CLAUDE_CONFIG_DIR, which asking
 *  a version needs none of. Everything else is what this same binary receives at launch anyway. */
export function claudeProbeEnv(sources: ClaudeChildEnvSources): Record<string, string> {
  return applyClaudeEnvPatch(
    claudeChildEnv(sources, true),
    {},
    {
      stripAuthEnv: true,
      platform: process.platform
    }
  )
}
