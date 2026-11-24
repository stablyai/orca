import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import type { ResolvedLaunchAccount } from '../../../../shared/agent-accounts/launch-account-ref'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'

/** The account a launch runs under is the one it requests, else the current selection; the
 *  receipt records what it used. */
export async function prepareClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  requested?: ResolvedLaunchAccount | null
): Promise<ClaudeAccountRecipe> {
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  const preparation = await router.prepareLaunch(requested ?? undefined)
  // A requested System default must not be routed through the host's selected account.
  const home =
    preparation.provenance === 'system' && !requested
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
  requested?: ResolvedLaunchAccount | null
): Promise<Record<string, string>> {
  const requestedHome =
    router && requested
      ? requested.kind === 'managed'
        ? router.accountHome(requested.accountId)
        : router.systemDefaultHome()
      : null
  const home = requestedHome
    ? requestedHome
    : router
      ? await resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          purpose: 'identity',
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : recordHome
  return { ...env, ...claudeConfigDirEnvPatch(home, { env }) }
}
