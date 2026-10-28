import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import { isHostManagedClaudeAccount } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

/** Label sign-in failures without changing inherited Anthropic authentication. */
export type ClaudeStructuredAuthPolicy = {
  account: AgentSessionAccountKind
}

/** Structured Claude runs a native local child, so use the host account selection. */
export function claudeStructuredAuthPolicyForSettings(
  settings: Partial<
    Pick<
      GlobalSettings,
      | 'claudeManagedAccounts'
      | 'activeClaudeManagedAccountId'
      | 'activeClaudeManagedAccountIdsByRuntime'
    >
  >
): ClaudeStructuredAuthPolicy {
  // Use the same fallback decision as terminals when the router is installed.
  const router = getClaudeProfileRouter()
  const managed = router
    ? router.routesToAccount()
    : isHostManagedClaudeAccount(
        settings.claudeManagedAccounts,
        getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
      )
  return { account: managed ? 'managed' : 'system' }
}
