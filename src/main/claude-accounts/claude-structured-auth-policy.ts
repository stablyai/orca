import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import { isHostManagedClaudeAccount } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

/** What a structured launch needs from the managed-account state: which login a failed
 *  sign-in names. A chat keeps the shell's Anthropic auth on every account, as terminals do. */
export type ClaudeStructuredAuthPolicy = {
  account: AgentSessionAccountKind
}

/**
 * The only supported way to build a structured launch's auth policy.
 *
 * Kept separate from runtime wiring so the settings-to-policy mapping can be tested directly.
 *
 * Structured Claude always spawns a native local-host child — the launch resolver
 * refuses any record with a remote execution host or a WSL distro — so the host
 * selection, not the platform default target, owns its auth.
 */
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
  // Why the router first: it decides whether the account or System default runs, as for terminals.
  const router = getClaudeProfileRouter()
  const managed = router
    ? router.routesToAccount()
    : isHostManagedClaudeAccount(
        settings.claudeManagedAccounts,
        getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
      )
  return { account: managed ? 'managed' : 'system' }
}
