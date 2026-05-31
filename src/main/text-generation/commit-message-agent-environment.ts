import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'
import { parseWslUncPath } from '../../shared/wsl-paths'

export type CommitMessageAgentEnvironmentResolvers = {
  prepareForCodexLaunch?: () => string | null
  prepareForClaudeLaunch?: () => Promise<ClaudeRuntimeAuthPreparation>
}

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

function readInheritedOrShellEnvVar(name: string, sourceName?: string): string | undefined {
  return (
    (sourceName ? process.env[sourceName] : undefined) ??
    process.env[name] ??
    readShellStartupEnvVar(name, process.env.HOME, process.env.SHELL)
  )
}

function prepareShellConfigDirEnv(agentId: string): { ok: true; env?: NodeJS.ProcessEnv } | null {
  const configVar =
    agentId === 'opencode'
      ? 'OPENCODE_CONFIG_DIR'
      : agentId === 'pi' || agentId === 'omp'
        ? 'PI_CODING_AGENT_DIR'
        : null
  if (!configVar) {
    return null
  }
  // Why: each kind owns a distinct ORCA_*_SOURCE_* shadow so a headless commit
  // run from inside an OMP overlay restores the OMP source dir, never the Pi
  // one (and vice versa). PI_CODING_AGENT_DIR is the binary-facing var both
  // kinds emit — see src/main/pi/titlebar-extension-service.ts.
  const sourceVar =
    agentId === 'opencode'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
        : agentId === 'omp'
          ? 'ORCA_OMP_SOURCE_AGENT_DIR'
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

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  const shellConfigEnv = prepareShellConfigDirEnv(agentId)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  if (!resolvers) {
    return { ok: true }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = resolvers.prepareForCodexLaunch()
      if (codexHomePath && parseWslUncPath(codexHomePath)) {
        // Why: this local generation path spawns the host Codex binary. A WSL
        // managed home is only valid when the process is routed through wsl.exe.
        return { ok: true }
      }
      return {
        ok: true,
        env: codexHomePath ? { ...cloneProcessEnv(), CODEX_HOME: codexHomePath } : undefined
      }
    }

    if (agentId === 'claude' && resolvers.prepareForClaudeLaunch) {
      const preparation = await resolvers.prepareForClaudeLaunch()
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
