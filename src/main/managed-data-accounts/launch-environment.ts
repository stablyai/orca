import type { TuiAgent } from '../../shared/tui-agent'
import type { ManagedDataAccountProvider } from '../../shared/managed-account-types'
import { getManagedDataAccountService, type ManagedDataAccountService } from './service'
import { MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS } from '../../shared/managed-data-account-environment'
import { getAgentLaunchExecutableName } from '../../shared/agent-command-line-intent'
import { MANAGED_DATA_ACCOUNT_RESUME_ENV } from '../../shared/managed-data-account-resume'

export function applyManagedDataAccountEnvironment(
  environment: Record<string, string>,
  options: { launchAgent?: TuiAgent; launchCommand?: string; isWsl?: boolean }
): void {
  const requestedAccountId = environment[MANAGED_DATA_ACCOUNT_RESUME_ENV]
  delete environment[MANAGED_DATA_ACCOUNT_RESUME_ENV]
  const service = getManagedDataAccountService()
  service.restoreOriginalEnvironment(environment)
  const inherited = { ...process.env }
  service.restoreOriginalEnvironment(inherited)
  for (const key of MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS) {
    const value = inherited[key]
    if (environment[key] === undefined && value !== undefined) {
      environment[key] = value
    }
  }
  if (options.isWsl) {
    return
  }
  const agent = options.launchAgent ?? getAgentLaunchExecutableName(options.launchCommand)
  const provider =
    agent === 'opencode' || agent === 'opencode2' ? 'opencode' : agent === 'devin' ? 'devin' : null
  if (!provider) {
    return
  }
  const selected = managedAccountLaunchEnvironment(service, provider, requestedAccountId)
  if (!selected.XDG_DATA_HOME) {
    return
  }
  service.captureOriginalEnvironment(environment, selected)
  Object.assign(environment, selected)
  environment.ORCA_DATA_ACCOUNT_DATA_HOME = selected.XDG_DATA_HOME
  environment.ORCA_DATA_ACCOUNT_STATE_HOME = selected.XDG_STATE_HOME
  environment.ORCA_DATA_ACCOUNT_PROVIDER = provider
  if (provider === 'opencode') {
    // Clear overrides that could bypass the selected profile's credentials.
    environment.OPENCODE_AUTH_CONTENT = ''
    environment.OPENCODE_DB = 'opencode.db'
  }
}

/** A resumed session's owning account wins; a removed owner falls back to the active account. */
export function managedAccountLaunchEnvironment(
  service: Pick<ManagedDataAccountService, 'environmentForAccount' | 'launchEnvironment'>,
  provider: ManagedDataAccountProvider,
  requestedAccountId: string | undefined
): Record<string, string> {
  if (requestedAccountId) {
    try {
      return service.environmentForAccount(provider, requestedAccountId)
    } catch {
      // Removed owner.
    }
  }
  return service.launchEnvironment(provider)
}
