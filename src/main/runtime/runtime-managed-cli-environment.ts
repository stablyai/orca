import {
  MANAGED_CLI_CONTEXT_ENV,
  managedCliContextToEnv,
  type ManagedCliContext
} from '../../shared/managed-cli-context'

const MANAGED_CLI_CONTEXT_ENV_KEYS = new Set(Object.values(MANAGED_CLI_CONTEXT_ENV))

export function stripManagedCliContextEnvKeys(env: Record<string, string>): Record<string, string> {
  const result = { ...env }
  for (const key of MANAGED_CLI_CONTEXT_ENV_KEYS) {
    delete result[key]
  }
  return result
}

export function applyManagedCliContextEnv(
  env: Record<string, string>,
  context: ManagedCliContext
): Record<string, string> {
  return { ...stripManagedCliContextEnvKeys(env), ...managedCliContextToEnv(context) }
}
