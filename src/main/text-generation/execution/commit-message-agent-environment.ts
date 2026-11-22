import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import {
  applyClaudeEnvPatch,
  CLAUDE_AUTH_ENV_VARS
} from '../../claude-accounts/runtime-auth/environment'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../shared/agent-accounts/claude/claude-profile-routing'
import { readShellStartupEnvVar } from '../../pty/shell-startup/shell-startup-env'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import {
  processEnvWithoutAgentSession,
  stripInheritedAgentSessionEnv
} from '../../../shared/agent-launch/startup/parent-agent-session-env'
import type { TextAccountFailover } from '../source-control-text-generation-types'

export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: (
    target?: CommitMessageAgentRuntimeTarget
  ) => string | null | Promise<string | null>
  prepareForClaudeLaunch?: (
    target?: CommitMessageAgentRuntimeTarget
  ) => Promise<ClaudeRuntimeAuthPreparation>
  /** The login-shell base env chats start from; a host-only source, never used for WSL. */
  resolveBaseEnvironment?: () => Promise<Record<string, string>>
  /** Opt-in quota failover; `baseEnv` carries no account routing. Undefined when off or unsupported. */
  prepareTextAccountFailover?: (
    agentId: 'claude' | 'codex',
    baseEnv: Record<string, string>
  ) => TextAccountFailover | undefined
}

export type PreparedCommitMessageAgentEnv = {
  ok: true
  env?: NodeJS.ProcessEnv
  accountFailover?: TextAccountFailover
}

export type CommitMessageAgentRuntimeTarget = {
  runtime?: 'host' | 'wsl'
  wslDistro?: string | null
}

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(processEnvWithoutAgentSession())) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

// System-default routing strips only Orca-marked inherited CODEX_HOME overlays; preserve user overrides.
function withoutOrcaCodexHomeOverride(base: Record<string, string>): Record<string, string> {
  const env = { ...base }
  if (env.ORCA_CODEX_HOME && env.CODEX_HOME === env.ORCA_CODEX_HOME) {
    delete env.CODEX_HOME
  }
  delete env.ORCA_CODEX_HOME
  return env
}

function readInheritedOrShellEnvVar(
  name: string,
  sourceName: string | undefined,
  base: Record<string, string> | undefined
): string | undefined {
  // Prefer saved overlay source, then chat login-shell base, over inherited Orca values.
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    base?.[name] ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

function prepareShellConfigDirEnv(
  agentId: string,
  base: Record<string, string> | undefined
): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode' || agentId === 'opencode2'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp'
        ? 'PI_CODING_AGENT_DIR'
        : agentId === 'grok'
          ? 'GROK_HOME'
          : null
  if (!configVar) {
    return null
  }
  // Pi/OMP share a binary config var but need distinct source shadows or nested legacy overlays restore the wrong agent directory.
  const sourceVar =
    agentId === 'opencode' || agentId === 'opencode2'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'ORCA_OMP_SOURCE_AGENT_DIR'
          : undefined

  const value = readInheritedOrShellEnvVar(configVar, sourceVar, base)
  if (!value) {
    return base ? { ok: true, env: base } : { ok: true }
  }

  // Recover GUI-missing auth/config exports while preferring original sources over nested PTY overlays.
  return { ok: true, env: { ...(base ?? cloneProcessEnv()), [configVar]: value } }
}

// The user's own credentials or config home pin the agent to one login, so no saved account replaces it.
function textAccountFailover(
  agentId: 'claude' | 'codex',
  resolvers: CommitMessageAgentEnvironmentResolvers,
  base: Record<string, string>
): TextAccountFailover | undefined {
  const pinned =
    agentId === 'claude'
      ? Boolean(
          base.CLAUDE_CONFIG_DIR && base.CLAUDE_CONFIG_DIR !== base[CLAUDE_INJECTED_CONFIG_DIR_ENV]
        ) || CLAUDE_AUTH_ENV_VARS.some((key) => base[key])
      : Boolean(base.OPENAI_API_KEY || base.CODEX_API_KEY) ||
        Boolean(base.CODEX_HOME && base.CODEX_HOME !== base.ORCA_CODEX_HOME)
  if (pinned || !resolvers.prepareTextAccountFailover) {
    return undefined
  }
  const unrouted = agentId === 'codex' ? withoutOrcaCodexHomeOverride(base) : { ...base }
  if (agentId === 'claude') {
    for (const key of [
      'CLAUDE_CONFIG_DIR',
      CLAUDE_INJECTED_CONFIG_DIR_ENV,
      CLAUDE_PROFILE_POINTER_ENV,
      CLAUDE_USER_CONFIG_DIR_ENV
    ]) {
      delete unrouted[key]
    }
  }
  try {
    return resolvers.prepareTextAccountFailover(agentId, unrouted)
  } catch (error) {
    console.error('[commit-message] Failed to prepare account failover:', error)
    return undefined
  }
}

async function resolveHostBaseEnv(
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined
): Promise<Record<string, string> | undefined> {
  if (!resolvers?.resolveBaseEnvironment) {
    return undefined
  }
  try {
    return { ...(await resolvers.resolveBaseEnvironment()) }
  } catch (error) {
    console.error('[commit-message] Failed to resolve the login-shell environment:', error)
    return undefined
  }
}

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined,
  target?: CommitMessageAgentRuntimeTarget
): Promise<PreparedCommitMessageAgentEnv | { ok: false; error: string }> {
  // Host agents need shell proxies/tokens; WSL resolves them in the guest.
  const hostBase = target?.runtime === 'wsl' ? undefined : await resolveHostBaseEnv(resolvers)
  // Shell-config agents short-circuit below; never put a Codex/Claude-style resolver agent on this path.
  const shellConfigEnv =
    target?.runtime === 'wsl' ? null : prepareShellConfigDirEnv(agentId, hostBase)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers && agentId !== 'claude') {
    return { ok: true }
  }
  const base = hostBase ?? cloneProcessEnv()
  stripInheritedAgentSessionEnv(base)
  if (!resolvers) {
    return { ok: true, env: base }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = await resolvers.prepareForCodexLaunch(target)
      const wslCodexHome = codexHomePath ? parseWslUncPath(codexHomePath) : null
      if (target?.runtime === 'wsl') {
        const codexHomeForTarget = wslCodexHome?.linuxPath ?? null
        // Fallback still strips Orca overlays so system-default WSL cannot inherit managed CODEX_HOME.
        return {
          ok: true,
          env: codexHomeForTarget
            ? { ...withoutOrcaCodexHomeOverride(base), CODEX_HOME: codexHomeForTarget }
            : withoutOrcaCodexHomeOverride(base)
        }
      }
      if (codexHomePath && wslCodexHome) {
        // Host-binary generation cannot use a guest managed home without wsl.exe routing.
        return hostBase ? { ok: true, env: hostBase } : { ok: true }
      }
      const accountFailover = textAccountFailover('codex', resolvers, base)
      return {
        ok: true,
        env: codexHomePath
          ? { ...base, CODEX_HOME: codexHomePath }
          : withoutOrcaCodexHomeOverride(base),
        ...(accountFailover ? { accountFailover } : {})
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const preparation = await resolvers.prepareForClaudeLaunch(target)
      const env = applyClaudeEnvPatch({ ...base }, preparation.envPatch)
      const accountFailover =
        target?.runtime === 'wsl' ? undefined : textAccountFailover('claude', resolvers, base)
      return { ok: true, env, ...(accountFailover ? { accountFailover } : {}) }
    }
  } catch (error) {
    console.error('[commit-message] Failed to prepare agent environment:', error)
    return {
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    }
  }

  return hostBase || agentId === 'claude' ? { ok: true, env: base } : { ok: true }
}
