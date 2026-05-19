import { createHash } from 'node:crypto'
import { createKeychainCache } from './keychain-cache'
import { getSecretsBackend } from './secrets-storage'

const ACTIVE_CLAUDE_SERVICE = 'Claude Code-credentials'
const ORCA_CLAUDE_SERVICE = 'Orca Claude Code Managed Credentials'

// Why: every workspace PTY spawn calls into runtime-auth which probes the
// secrets backend per active account; without caching this becomes an N+1
// shell-out (keychain backend) that stalls workspace launch (autoplan E2).
// Size 50 covers practical multi-account fleets and bounds memory. The
// encrypted-file backend doesn't need this cache (file is in memory after
// first read), but it's cheap to leave on and avoids re-decrypts.
const managedKeychainCache = createKeychainCache(50)

export async function readActiveClaudeKeychainCredentials(
  configDir?: string
): Promise<string | null> {
  const backend = await getSecretsBackend()
  for (const service of getActiveClaudeServices(configDir)) {
    const value = await backend.read(service, getKeychainUser())
    if (value) {
      return value
    }
  }
  return null
}

export async function readActiveClaudeKeychainCredentialsStrict(
  configDir?: string
): Promise<string | null> {
  const backend = await getSecretsBackend()
  return backend.read(getActiveClaudeService(configDir), getKeychainUser())
}

export async function writeActiveClaudeKeychainCredentials(
  contents: string,
  configDir?: string
): Promise<void> {
  const backend = await getSecretsBackend()
  await backend.write(getActiveClaudeService(configDir), getKeychainUser(), contents)
}

export async function writeActiveClaudeKeychainCredentialsForRuntime(
  contents: string,
  configDir: string
): Promise<void> {
  const backend = await getSecretsBackend()
  const user = getKeychainUser()
  const scopedService = getActiveClaudeService(configDir)
  await backend.write(scopedService, user, contents)
  if (scopedService !== ACTIVE_CLAUDE_SERVICE) {
    await backend.write(ACTIVE_CLAUDE_SERVICE, user, contents)
  }
}

export async function deleteActiveClaudeKeychainCredentials(configDir?: string): Promise<void> {
  const backend = await getSecretsBackend()
  for (const service of getActiveClaudeServices(configDir)) {
    await backend.delete(service, getKeychainUser())
  }
}

export async function deleteActiveClaudeKeychainCredentialsStrict(
  configDir?: string
): Promise<void> {
  const backend = await getSecretsBackend()
  await backend.delete(getActiveClaudeService(configDir), getKeychainUser())
}

export async function readManagedClaudeKeychainCredentials(
  accountId: string
): Promise<string | null> {
  if (managedKeychainCache.has(accountId)) {
    return managedKeychainCache.get(accountId) ?? null
  }
  const backend = await getSecretsBackend()
  const value = await backend.read(ORCA_CLAUDE_SERVICE, accountId)
  // Cache misses too — the null sentinel suppresses re-probes for missing
  // accounts on the workspace-launch hot path.
  managedKeychainCache.set(accountId, value)
  return value
}

export async function writeManagedClaudeKeychainCredentials(
  accountId: string,
  contents: string
): Promise<void> {
  const backend = await getSecretsBackend()
  await backend.write(ORCA_CLAUDE_SERVICE, accountId, contents)
  // Invalidate; let the next read re-fetch from the source of truth.
  managedKeychainCache.invalidate(accountId)
}

export async function deleteManagedClaudeKeychainCredentials(accountId: string): Promise<void> {
  const backend = await getSecretsBackend()
  await backend.delete(ORCA_CLAUDE_SERVICE, accountId)
  managedKeychainCache.invalidate(accountId)
}

// Test-only escape hatch — not exported from index. Used by integration tests
// to reset cache state between cases.
export function __resetKeychainCacheForTests(): void {
  managedKeychainCache.clear()
}

function getKeychainUser(): string {
  return process.env.USER || process.env.USERNAME || 'user'
}

function getActiveClaudeService(configDir?: string): string {
  if (!configDir) {
    return ACTIVE_CLAUDE_SERVICE
  }
  // Why: Claude Code 2.1+ scopes macOS Keychain credentials by config dir
  // using the first 8 hex chars of sha256(CLAUDE_CONFIG_DIR).
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${ACTIVE_CLAUDE_SERVICE}-${suffix}`
}

function getActiveClaudeServices(configDir?: string): string[] {
  const scopedService = getActiveClaudeService(configDir)
  return scopedService === ACTIVE_CLAUDE_SERVICE
    ? [ACTIVE_CLAUDE_SERVICE]
    : [scopedService, ACTIVE_CLAUDE_SERVICE]
}
