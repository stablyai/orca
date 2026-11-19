import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { acquiredAgentSessionAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'
import { getClaudeWorkspaceProfiles } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import {
  CLAUDE_USAGE_ACCOUNT_ID_ENV,
  claudeSystemDefaultUsageAccountId
} from '../../../../shared/agent-accounts/claude/claude-system-default-usage-account'

/** Existing conversations keep their acquired account; fresh chats resolve the workspace selection. */
export async function prepareClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  workspaceId?: string,
  providerSessionId?: string,
  record?: AgentSessionRecord
): Promise<ClaudeAccountRecipe> {
  if (providerSessionId) {
    await router?.environmentReady
    const acquired = record ? acquiredAgentSessionAccount(record)?.recipe : undefined
    recordHome = acquired?.home ?? recordHome
    const systemHome = router?.systemDefaultHome()
    if (acquired?.route === 'managed') {
      env[CLAUDE_USAGE_ACCOUNT_ID_ENV] = acquired.accountId
    } else if (
      systemHome &&
      normalizeRuntimePathForComparison(recordHome) ===
        normalizeRuntimePathForComparison(systemHome)
    ) {
      const login = router?.systemDefaultLogin()
      env[CLAUDE_USAGE_ACCOUNT_ID_ENV] = claudeSystemDefaultUsageAccountId(
        login?.email,
        login?.organizationUuid
      )
    } else {
      delete env[CLAUDE_USAGE_ACCOUNT_ID_ENV]
    }
    if (
      !systemHome ||
      normalizeRuntimePathForComparison(recordHome) !==
        normalizeRuntimePathForComparison(systemHome)
    ) {
      env.CLAUDE_CONFIG_DIR = recordHome
    } else {
      delete env.CLAUDE_CONFIG_DIR
    }
    env.ORCA_CLAUDE_PROFILE_POINTER = ''
    env.ORCA_CLAUDE_INJECTED_CONFIG_DIR = recordHome
    return acquired ?? { route: 'system', home: recordHome, configDir: recordHome }
  }
  const workspace = await getClaudeWorkspaceProfiles()?.resolve(
    workspaceId,
    { runtime: 'host' },
    true
  )
  if (workspace) {
    applyClaudeEnvPatch(env, workspace.envPatch)
    if (!workspace.readingAccount?.accountId) {
      return { route: 'system', home: workspace.configDir, configDir: workspace.configDir }
    }
    return {
      route: 'managed',
      accountId: workspace.readingAccount.accountId,
      home: workspace.configDir
    }
  }
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
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
  recordHome: string
): Promise<Record<string, string>> {
  const home = router
    ? await resolveStructuredClaudeAccountHomePath({
        launchEnv: env,
        wslDistro: null,
        purpose: 'identity',
        getClaudeConfigDirectory: () => router.systemDefaultHome()
      })
    : recordHome
  return { ...env, ...claudeConfigDirEnvPatch(home, { env }) }
}
