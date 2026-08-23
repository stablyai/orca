import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { parseWslUncPath } from '../../shared/wsl-paths'

/** Optional per-runtime resolvers that prepare env for Codex or Claude launches. */
export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: (target?: CommitMessageAgentRuntimeTarget) => string | null
  prepareForClaudeLaunch?: (
    target?: CommitMessageAgentRuntimeTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>
}

/** Where the headless commit-message run executes: host or a named WSL distro. */
export type CommitMessageAgentRuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

/** Copies the current process environment into a plain record, skipping
 *  values that are not set. */
function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

// Why: with system-default real-home routing, the headless Codex commit run
// must use the user's own ~/.codex. If Orca itself was launched from a nested
// Orca terminal it can inherit an Orca-owned CODEX_HOME override; strip only
// that (CODEX_HOME matching the private ORCA_CODEX_HOME marker), preserving a
// user-set CODEX_HOME.
/** Clones the process env but strips the Orca-owned CODEX_HOME override
 *  (a CODEX_HOME matching the private ORCA_CODEX_HOME marker) so headless
 *  commit runs use the user's real ~/.codex. */
function cloneProcessEnvWithoutOrcaCodexHomeOverride(): Record<string, string> {
  const env = cloneProcessEnv()
  if (env.ORCA_CODEX_HOME && env.CODEX_HOME === env.ORCA_CODEX_HOME) {
    delete env.CODEX_HOME
  }
  delete env.ORCA_CODEX_HOME
  return env
}

/** Reads an env var from the inherited process env (preferring the ORCA-owned
 *  source overlay when given) or, failing that, from the user's shell startup
 *  files.
 *  @param name - The env var to resolve.
 *  @param sourceName - Optional ORCA_*_SOURCE_* overlay var to prefer first.
 *  @returns The resolved value, or undefined when neither source sets it. */
function readInheritedOrShellEnvVar(name: string, sourceName?: string): string | undefined {
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

/** Resolves the config-dir env for shell-config-backed agents (opencode, pi,
 *  omp, prime-agent, grok), hydrating it from the inherited env or shell
 *  startup files and restoring the kind-specific source overlay when present.
 *  @param agentId - The agent id to prepare env for.
 *  @returns The env patch to apply, or null for agents without a shell config
 *    dir. */
function prepareShellConfigDirEnv(agentId: string): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp' || agentId === 'prime-agent'
        ? agentId === 'prime-agent'
          ? 'PRIME_AGENT_CODING_AGENT_DIR'
          : 'PI_CODING_AGENT_DIR'
        : agentId === 'grok'
          ? 'GROK_HOME'
          : null
  if (!configVar) {
    return null
  }
  // Why: each kind owns a distinct ORCA_*_SOURCE_* shadow so a headless commit
  // run from inside a legacy OMP overlay restores the OMP source dir, never
  // the Pi one (and vice versa). PI_CODING_AGENT_DIR is the binary-facing var
  // both kinds consume — see src/main/pi/titlebar-extension-service.ts.
  const sourceVar =
    agentId === 'opencode'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'ORCA_OMP_SOURCE_AGENT_DIR'
          : agentId === 'prime-agent'
            ? 'ORCA_PRIME_AGENT_SOURCE_AGENT_DIR'
            : undefined

  const value = readInheritedOrShellEnvVar(configVar, sourceVar)
  if (!value) {
    return { ok: true }
  }

  // Why: GUI-launched Orca may not inherit shell startup exports, but these
  // vars point the headless CLI at the user's auth/config root. Nested Orca
  // launches inherit PTY overlays, so prefer ORCA_*_SOURCE_* when present.
  return { ok: true, env: { ...cloneProcessEnv(), [configVar]: value } }
}

/** Prepares the environment for a headless commit-message (or SourceControl
 *  AI) agent run: shell-config env for the pi-family agents, Codex/Claude
 *  resolver paths for those runtimes, with per-target WSL handling.
 *  @param agentId - The agent id to prepare env for.
 *  @param resolvers - Optional Codex/Claude launch resolvers used when the
 *    agent has no shell-config env.
 *  @param target - Optional runtime target (host vs WSL) for the run.
 *  @returns The prepared env, or a failure result when preparation errors. */
export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target?: CommitMessageAgentRuntimeTarget
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  // Why: a non-null result short-circuits the resolvers below, so any agent added
  // to prepareShellConfigDirEnv must not also need a Codex/Claude-style resolver.
  const shellConfigEnv = target?.runtime === 'wsl' ? null : prepareShellConfigDirEnv(agentId)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers) {
    return { ok: true }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = resolvers.prepareForCodexLaunch(target)
      const wslCodexHome = codexHomePath ? parseWslUncPath(codexHomePath) : null
      if (target?.runtime === 'wsl') {
        const codexHomeForTarget = wslCodexHome?.linuxPath ?? null
        // Why: the fallback must still strip Orca-owned overrides, or a
        // system-default WSL run inherits the managed CODEX_HOME.
        return {
          ok: true,
          env: codexHomeForTarget
            ? { ...cloneProcessEnvWithoutOrcaCodexHomeOverride(), CODEX_HOME: codexHomeForTarget }
            : cloneProcessEnvWithoutOrcaCodexHomeOverride()
        }
      }
      if (codexHomePath && wslCodexHome) {
        // Why: this local generation path spawns the host Codex binary. A WSL
        // managed home is only valid when the process is routed through wsl.exe.
        return { ok: true }
      }
      return {
        ok: true,
        env: codexHomePath
          ? { ...cloneProcessEnv(), CODEX_HOME: codexHomePath }
          : cloneProcessEnvWithoutOrcaCodexHomeOverride()
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const preparation = await resolvers.prepareForClaudeLaunch(target)
      const env = applyClaudeEnvPatch(cloneProcessEnv(), preparation.envPatch, {
        stripAuthEnv: preparation.stripAuthEnv
      })
      return { ok: true, env }
    }
  } catch (error) {
    console.error('[commit-message] Failed to prepare agent environment:', error)
    return {
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    }
  }

  return { ok: true }
}
