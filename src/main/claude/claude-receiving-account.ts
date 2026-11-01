import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/claude-profile-routing'
import type { ClaudeAccountRecipe } from '../../shared/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { claudeProfileMissing } from '../claude-accounts/claude-profile-launch-errors'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/structured-agent-account-home'

/** Only actual preparation produces a receipt; selection is never backfilled as acquisition. */
export async function prepareClaudeReceivingAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  receiving?: ClaudeAccountRecipe
): Promise<ClaudeAccountRecipe> {
  if (receiving?.route === 'managed') {
    if (!router) {
      throw claudeProfileMissing()
    }
    const home = await router.prepareReceivingAccount(receiving.accountId)
    applyClaudeEnvPatch(env, { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home })
    return { ...receiving, home }
  }
  if (receiving) {
    if (receiving.configDir === null) {
      delete env.CLAUDE_CONFIG_DIR
    } else {
      env.CLAUDE_CONFIG_DIR = receiving.configDir
    }
    return receiving
  }
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  const preparation = await router.prepareLaunch()
  const home =
    preparation.provenance === 'system'
      ? resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : preparation.configDir
  applyClaudeEnvPatch(env, preparation.envPatch)
  return preparation.provenance.startsWith('profile:')
    ? { route: 'managed', accountId: preparation.provenance.slice('profile:'.length), home }
    : { route: 'system', home, configDir: env.CLAUDE_CONFIG_DIR ?? null }
}
