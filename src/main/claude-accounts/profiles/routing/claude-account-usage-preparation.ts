import { isSameClaudeLogin } from '../../sign-in/claude-account-folder'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import { CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID } from '../../../../shared/agent-accounts/claude/claude-system-default-usage'
import type { ClaudeFolderLogin } from '../../sign-in/claude-account-folder'
import { claudeSystemDefaultUsageAccountId } from '../../../../shared/agent-accounts/claude/claude-system-default-usage-account'

export function claudeWorkspaceUsageAccountId(
  profileAccountId: string | undefined,
  systemDefaultLogin: ClaudeFolderLogin | null
): string {
  return (
    profileAccountId ??
    claudeSystemDefaultUsageAccountId(
      systemDefaultLogin?.email,
      systemDefaultLogin?.organizationUuid
    )
  )
}

/** Usage reads use the same login route as account launches. */
export function claudeAccountUsagePreparation(
  router: Pick<ClaudeProfileRouter, 'coveredBySystemDefault' | 'systemDefaultHome' | 'accountHome'>,
  accountId: string
): ClaudeRuntimeAuthPreparation {
  if (
    accountId === CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID ||
    router.coveredBySystemDefault(accountId)
  ) {
    // Setting CLAUDE_CONFIG_DIR for System default changes its Keychain identity.
    return {
      configDir: router.systemDefaultHome(),
      envPatch: {},
      provenance: 'system'
    }
  }
  const home = router.accountHome(accountId)
  return {
    configDir: home,
    envPatch: { CLAUDE_CONFIG_DIR: home },
    provenance: `profile:${accountId}`,
    readingAccount: { accountId, runtime: 'host', wslDistro: null }
  }
}

export function claudeSystemDefaultRunsAnotherAccount(
  router: Pick<
    ClaudeProfileRouter,
    'selectedProfile' | 'accountLogin' | 'savedAccount' | 'systemDefaultLogin'
  >
): boolean | null {
  const profile = router.selectedProfile()
  if (!profile) {
    return null
  }
  const selected = router.accountLogin(profile.accountId) ?? router.savedAccount(profile.accountId)
  const system = router.systemDefaultLogin(5_000)
  return !selected || !system || !isSameClaudeLogin(selected, system)
}
