import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  claudeProfileMissing,
  claudeProfileSetupFailed
} from '../../../claude-accounts/profiles/routing/claude-profile-launch-errors'
import { claudeBoundHomeAsync } from '../../../claude-accounts/profiles/routing/claude-profile-routed-home'
import type { ClaudeAccountBinding } from '../../../../shared/agent-accounts/claude/claude-account-binding'
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../../../shared/agent-accounts/claude/claude-profile-routing'
import { installedClaudeAccountBinding } from '../../../claude-accounts/selection/claude-workspace-account-binding'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'

/** The account a launch runs under is its project's bound account, else the current selection;
 *  the receipt records what it used. */
export async function prepareClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  workspaceId?: string
): Promise<ClaudeAccountRecipe> {
  const binding = installedClaudeAccountBinding(workspaceId)
  if (!router) {
    if (binding) {
      throw claudeProfileMissing()
    }
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  if (binding) {
    return prepareBoundClaudeLaunch(router, binding, env)
  }
  const preparation = await router.prepareLaunch()
  const home =
    preparation.provenance === 'system'
      ? await resolveStructuredClaudeAccountHomePath({
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

/** Pins the account a launch would run under now, without preparing its folder: managed settings
 *  can refuse flags per account, so flag checks must ask as that account. */
export async function withClaudeLaunchAccountPin(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  workspaceId?: string
): Promise<Record<string, string>> {
  const home = router
    ? await resolveStructuredClaudeAccountHomePath({
        launchEnv: env,
        wslDistro: null,
        ...(workspaceId ? { workspaceId } : {}),
        purpose: 'identity',
        getClaudeConfigDirectory: () => router.systemDefaultHome()
      })
    : recordHome
  return { ...env, ...claudeConfigDirEnvPatch(home, { env }) }
}

/** Refuses rather than fall back to the selection, which would run the project on another account. */
async function prepareBoundClaudeLaunch(
  router: ClaudeProfileRouter,
  binding: ClaudeAccountBinding,
  env: Record<string, string>
): Promise<ClaudeAccountRecipe> {
  if (binding.kind === 'managed') {
    if (!router.savedAccount(binding.accountId)) {
      throw claudeProfileMissing()
    }
    await router.prepareAccount(binding.accountId).catch(() => {
      throw claudeProfileSetupFailed()
    })
  }
  const home = await claudeBoundHomeAsync(router, binding)
  // Why: naming the default folder explicitly changes the CLI's Keychain identity on macOS.
  if (
    claudeConfigDirEnvPatch(home, { env: { CLAUDE_CONFIG_DIR: router.systemDefaultHome() } })
      .CLAUDE_CONFIG_DIR
  ) {
    applyClaudeEnvPatch(env, { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home })
  }
  return binding.kind === 'managed'
    ? { route: 'managed', accountId: binding.accountId, home }
    : { route: 'system', home, configDir: home }
}
