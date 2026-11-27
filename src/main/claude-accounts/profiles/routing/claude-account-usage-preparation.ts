import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from '../../runtime-auth/runtime-auth-types'
import { HOST_SYSTEM_DEFAULT_USAGE_IDS } from '../../../../shared/agent-accounts/host-system-default-usage'

/** Usage reads use the same login route as account launches. */
export function claudeAccountUsagePreparation(
  router: Pick<ClaudeProfileRouter, 'coveredBySystemDefault' | 'systemDefaultHome' | 'accountHome'>,
  accountId: string
): ClaudeRuntimeAuthPreparation {
  if (
    accountId === HOST_SYSTEM_DEFAULT_USAGE_IDS.claude ||
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
