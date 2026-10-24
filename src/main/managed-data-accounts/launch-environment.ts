import type { TuiAgent } from '../../shared/tui-agent'
import { getManagedDataAccountService } from './service'
import { MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS } from '../../shared/managed-data-account-environment'
import { getAgentLaunchExecutableName } from '../../shared/agent-command-line-intent'

export function applyManagedDataAccountEnvironment(
  environment: Record<string, string>,
  options: { launchAgent?: TuiAgent; launchCommand?: string; isWsl?: boolean }
): void {
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
  const selected = service.launchEnvironment(provider)
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
