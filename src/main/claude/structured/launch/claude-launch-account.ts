import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { acquiredAgentSessionAccount } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'
import { getClaudeWorkspaceProfiles } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'

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
    const acquired = record ? acquiredAgentSessionAccount(record)?.recipe : undefined
    recordHome = acquired?.home ?? recordHome
    env.CLAUDE_CONFIG_DIR = recordHome
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
