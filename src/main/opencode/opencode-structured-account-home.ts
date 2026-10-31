import {
  isLegacyAgentSessionAccountHome,
  type OpenCodeAgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import {
  getManagedDataAccountService,
  type ManagedDataAccountService
} from '../managed-data-accounts/service'
import type { AcpAccountBinding } from '../acp/acp-account-binding'
import {
  definedEnvironment,
  restoredManagedDataAccountEnvironment
} from '../managed-data-accounts/managed-data-account-restored-environment'

type AccountReader = Pick<
  ManagedDataAccountService,
  'list' | 'restoreOriginalEnvironment' | 'environmentForAccount'
>

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

/** Resolve on the current host and apply after inherited overlays. */
export function environmentForStructuredOpenCodeAccountHome(
  binding: OpenCodeAgentSessionAccountHome,
  input: {
    managedAccounts: Pick<AccountReader, 'environmentForAccount' | 'restoreOriginalEnvironment'>
    baseEnvironment: NodeJS.ProcessEnv
  }
): Record<string, string> {
  const environment = restoredManagedDataAccountEnvironment(
    input.baseEnvironment,
    input.managedAccounts
  )
  const locator = binding.locator
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
