import {
  isLegacyAgentSessionAccountHome,
  type OpenCodeAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import {
  getManagedDataAccountService,
  type ManagedDataAccountService
} from '../managed-data-accounts/service'
import type { AcpAccountBinding } from '../acp/acp-account-binding'

type AccountReader = Pick<
  ManagedDataAccountService,
  'list' | 'restoreOriginalEnvironment' | 'environmentForAccount'
>

function restoredEnvironment(
  environment: NodeJS.ProcessEnv,
  managedAccounts: Pick<AccountReader, 'restoreOriginalEnvironment'>
): Record<string, string | undefined> {
  const copy = { ...environment }
  managedAccounts.restoreOriginalEnvironment(copy)
  delete copy.ORCA_DATA_ACCOUNT_PROVIDER
  delete copy.ORCA_DATA_ACCOUNT_DATA_HOME
  delete copy.ORCA_DATA_ACCOUNT_STATE_HOME
  delete copy.ORCA_DATA_ACCOUNT_ORIGINAL_ENV
  return copy
}

function definedEnvironment(
  environment: Record<string, string | undefined>
): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      defined[key] = value
    }
  }
  return defined
}

/** Resolve the current selection on the execution host when creating a chat. */
export function resolveStructuredOpenCodeAccountHome(input: {
  managedAccounts: AccountReader
}): OpenCodeAgentSessionAccountHome {
  const selected = input.managedAccounts.list('opencode').activeAccountId
  if (selected) {
    input.managedAccounts.environmentForAccount('opencode', selected)
    return { kind: 'opencode', locator: { kind: 'managed', managedProfileId: selected } }
  }
  return { kind: 'opencode', locator: { kind: 'unmanaged' } }
}

/** Resolve a saved binding against the current host, then apply it after inherited overlays. */
export function environmentForStructuredOpenCodeAccountHome(
  binding: OpenCodeAgentSessionAccountHome,
  input: {
    managedAccounts: Pick<AccountReader, 'environmentForAccount' | 'restoreOriginalEnvironment'>
    baseEnvironment: Record<string, string>
  }
): Record<string, string> {
  const environment = restoredEnvironment(input.baseEnvironment, input.managedAccounts)
  const locator = binding.locator
  // Unmanaged: the user's own environment reaches OpenCode as-is.
  if (locator.kind === 'unmanaged') {
    return definedEnvironment(environment)
  }
  delete environment.XDG_DATA_HOME
  delete environment.XDG_STATE_HOME
  delete environment.OPENCODE_DB
  delete environment.OPENCODE_AUTH_CONTENT
  return {
    ...definedEnvironment(environment),
    ...input.managedAccounts.environmentForAccount('opencode', locator.managedProfileId)
  }
}

/** OpenCode's account over ACP: a managed profile, or the user's own environment. */
export function openCodeAcpAccountBinding(
  managedAccounts: () => AccountReader = getManagedDataAccountService
): AcpAccountBinding {
  return {
    pin: { accountLocatorKind: 'opencode' },
    resolve: async () =>
      resolveStructuredOpenCodeAccountHome({ managedAccounts: managedAccounts() }),
    environment: (home, env) => {
      if (isLegacyAgentSessionAccountHome(home)) {
        throw new Error('OpenCode chat requires a pinned data account')
      }
      return environmentForStructuredOpenCodeAccountHome(home, {
        managedAccounts: managedAccounts(),
        baseEnvironment: env
      })
    }
  }
}
