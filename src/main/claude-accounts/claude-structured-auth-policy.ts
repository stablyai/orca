import type { GlobalSettings } from '../../shared/global-settings-types'
import { shouldStripClaudeAuthEnvForAccount } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

/** The structured mirror of the terminal preflight's `prepareClaudeAuth` result:
 *  the one field a launch resolution needs from the managed-account state. */
export type ClaudeStructuredAuthPolicy = {
  stripAuthEnv: boolean
}

/**
 * The only supported way to build a structured launch's auth policy.
 *
 * It exists as a named function rather than an inline object at the wiring site so
 * that the settings-to-policy mapping is testable on its own: the one production
 * wiring lives in a `@ts-nocheck` file, where neither the compiler nor a type test
 * can see a dropped field.
 *
 * Structured Claude always spawns a native local-host child — the launch resolver
 * refuses any record with a remote execution host or a WSL distro — so the host
 * selection, not the platform default target, owns its auth.
 */
export function claudeStructuredAuthPolicyForSettings(
  settings: Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'activeClaudeManagedAccountIdsByRuntime'
  >
): ClaudeStructuredAuthPolicy {
  return {
    stripAuthEnv: shouldStripClaudeAuthEnvForAccount(
      settings.claudeManagedAccounts,
      getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
    )
  }
}
