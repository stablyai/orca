import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { readShellStartupEnvVar } from '../pty/shell-startup-env'

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
    agentId === 'opencode' ? 'OPENCODE_CONFIG_DIR' : agentId === 'pi' ? 'PI_CODING_AGENT_DIR' : null
  if (!configVar) {
    return null
  }
  const sourceVar =
    agentId === 'opencode'
      ? 'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
      : agentId === 'pi'
        ? 'ORCA_PI_SOURCE_AGENT_DIR'
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

function prepareGeminiEnv(agentId: string): { ok: true; env?: NodeJS.ProcessEnv } | null {
  if (agentId !== 'gemini') {
    return null
  }
  const apiKey = readInheritedOrShellEnvVar('GEMINI_API_KEY')
  if (!apiKey) {
    return { ok: true }
  }

  // Why: GUI-launched Orca often lacks shell exports, while `gemini` relies on
  // GEMINI_API_KEY for headless API mode even when the same CLI works in a terminal.
  return { ok: true, env: { ...cloneProcessEnv(), GEMINI_API_KEY: apiKey } }
}

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
  const shellConfigEnv = prepareShellConfigDirEnv(agentId)
  if (shellConfigEnv) {
    return shellConfigEnv
  }
  const geminiEnv = prepareGeminiEnv(agentId)
  if (geminiEnv) {
    return geminiEnv
  }
  if (!resolvers) {
    return { ok: true }
  }

  try {
    if (agentId === 'codex' && resolvers.prepareForCodexLaunch) {
      const codexHomePath = resolvers.prepareForCodexLaunch()
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
