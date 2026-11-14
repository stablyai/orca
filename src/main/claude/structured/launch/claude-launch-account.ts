import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { claudeProvenanceAccountId } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'

/** The launch account is the selection or the chat's dynamic pin; the receipt records which. */
export async function prepareClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string
): Promise<ClaudeAccountRecipe> {
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  const preparation = await router.prepareLaunch(router.dynamicLaunch?.pinnedAccount(recordHome))
  const home =
    preparation.provenance === 'system'
      ? await resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : preparation.configDir
  applyClaudeEnvPatch(env, preparation.envPatch)
  const accountId = claudeProvenanceAccountId(preparation.provenance)
  return accountId
    ? { route: 'managed', accountId, home }
    : { route: 'system', home, configDir: env.CLAUDE_CONFIG_DIR ?? null }
}
