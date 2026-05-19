import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch, applyEnvFromMaterialization } from '../claude-accounts/environment'

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

export async function prepareLocalCommitMessageAgentEnv(
  agentId: string,
  resolvers: CommitMessageAgentEnvironmentResolvers | undefined
): Promise<{ ok: true; env?: NodeJS.ProcessEnv } | { ok: false; error: string }> {
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
      // Why: non-OAuth providers ship credentials through `materialization`
      // (autoplan E5/T12). applyEnvFromMaterialization strips every known
      // provider key and re-emits from the patch so an API-key account's
      // ANTHROPIC_API_KEY actually reaches the spawned agent.
      const env = preparation.materialization
        ? applyEnvFromMaterialization(cloneProcessEnv(), preparation.materialization)
        : applyClaudeEnvPatch(cloneProcessEnv(), preparation.envPatch, {
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
