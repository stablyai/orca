import type { ManagedDataAccountService } from './service'

export const MANAGED_DATA_ACCOUNT_MARKER_ENV_KEYS = [
  'ORCA_DATA_ACCOUNT_PROVIDER',
  'ORCA_DATA_ACCOUNT_DATA_HOME',
  'ORCA_DATA_ACCOUNT_STATE_HOME',
  'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
] as const

export function restoredManagedDataAccountEnvironment(
  environment: NodeJS.ProcessEnv,
  managedAccounts: Pick<ManagedDataAccountService, 'restoreOriginalEnvironment'>
): Record<string, string | undefined> {
  const copy = { ...environment }
  managedAccounts.restoreOriginalEnvironment(copy)
  for (const key of MANAGED_DATA_ACCOUNT_MARKER_ENV_KEYS) {
    delete copy[key]
  }
  return copy
}

export function definedEnvironment(
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
