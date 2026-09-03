import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { toWindowsWslPath } from '../../wsl'
import { runWslProcess } from '../../wsl/wsl-runner'
import {
  ClaudeManagedAuthTemporarilyUnavailableError,
  readClaudeManagedAuthFile,
  resolveClaudeManagedAuthOwnership,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from '../managed-auth-path'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from '../oauth-refresh'
import {
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { ClaudeRuntimeAuthCredentialIdentity } from './runtime-auth-credential-identity'
import {
  readComposedClaudeCredentials,
  type ClaudeCredentialUnavailableReason
} from '../claude-credential-read-result'
import { hasClaudeStaleFallbackMark } from '../claude-stale-fallback-marker'

/** A store we could not read is not an account without credentials. */
export class ClaudeManagedCredentialsUnavailableError extends Error {
  constructor(readonly reason: ClaudeCredentialUnavailableReason) {
    super(`Managed Claude credentials are unavailable: ${reason}`)
    this.name = 'ClaudeManagedCredentialsUnavailableError'
  }
}

const OWNERSHIP_PROBE_TIMEOUT = 'orca-wsl-ownership-probe-timeout'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export class ClaudeRuntimeAuthManagedCredentials extends ClaudeRuntimeAuthCredentialIdentity {
  protected async readManagedCredentials(account: ClaudeManagedAccount): Promise<string | null> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return null
    }
    if (process.platform !== 'darwin') {
      return readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
    }
    // Only an isolated account has a config-dir-scoped store of its own. A pre-isolation account
    // runs against the shared `~/.claude` and reads the service derived from *that* dir, so
    // deriving one from its private path would look somewhere nothing ever writes.
    if (account.managedAuthRuntime !== 'host') {
      return readManagedClaudeKeychainCredentials(account.id)
    }
    // The CLI keeps this account's credential in the Keychain item it derives from this very dir,
    // with the same-home file as its own durable fallback. Reading that pair is what keeps macOS
    // to one store, like every other platform.
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: () => readActiveClaudeKeychainCredentialsStrict(managedAuthPath),
      hasStaleFallbackMarker: () => hasClaudeStaleFallbackMark(managedAuthPath),
      readSameHomeFile: () => readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
    })
    // Callers on this path treat null as "no usable credential". That is honest for a blob we did
    // read and found corrupt, but a lie for a store we could not read at all — so only the latter
    // throws, and a locked Keychain never masquerades as a signed-out account.
    if (result.kind === 'unavailable' && result.reason !== 'malformed') {
      throw new ClaudeManagedCredentialsUnavailableError(result.reason)
    }
    return result.kind === 'present' ? result.credentialsJson : null
  }

  // Why: the CLI persists rotations to this file whenever the Keychain write fails durably, so it
  // is a real credential source and must be read back, not just written.
  protected async readManagedCredentialsFileCandidate(
    account: ClaudeManagedAccount
  ): Promise<string | null> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return null
    }
    return readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
  }

  // Why: the CLI keeps one live store — once the Keychain write succeeds it drops the fallback
  // file, so leaving ours behind would resurrect a consumed token on a later read.
  protected async clearManagedCredentialsFile(account: ClaudeManagedAccount): Promise<void> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return
    }
    rmSync(join(managedAuthPath, '.credentials.json'), { force: true })
  }

  // Why: mirrors the CLI's own keychain-primary/file-fallback contract — when the scoped Keychain
  // is unusable, degrade the storage medium inside the isolated home, never the account identity.
  protected async materializeManagedCredentialsFile(
    account: ClaudeManagedAccount
  ): Promise<boolean> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return false
    }
    const credentialsJson = await this.readManagedCredentials(account)
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      return false
    }
    writeClaudeManagedAuthFile(managedAuthPath, '.credentials.json', credentialsJson)
    return true
  }

  protected async writeManagedCredentials(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    if (process.platform === 'darwin') {
      await (account.managedAuthRuntime === 'host'
        ? writeActiveClaudeKeychainCredentials(credentialsJson, managedAuthPath)
        : writeManagedClaudeKeychainCredentials(account.id, credentialsJson))
      return
    }
    writeClaudeManagedAuthFile(managedAuthPath, '.credentials.json', credentialsJson)
  }

  /**
   * Proactively refresh an account's OAuth token and persist the rotation to
   * managed storage. Returns the refreshed credentials JSON, or null when no
   * refresh happened (token valid, no refresh token, or network failure).
   *
   * Caller guarantees this account isn't the live/active one and runs inside the
   * serialized mutation queue, so the single-use refresh token can't rotate concurrently.
   */
  protected async refreshManagedAccountTokenIfNeeded(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<string | null> {
    if (!isOauthTokenExpiring(credentialsJson)) {
      return null
    }
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (!refreshed || !this.isValidCredentialsJsonObject(refreshed)) {
      return null
    }
    try {
      await this.writeManagedCredentials(account, refreshed)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to persist refreshed Claude token:', error)
      return null
    }
    return refreshed
  }

  protected async readManagedOauthAccount(account: ClaudeManagedAccount): Promise<unknown> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      return null
    }
    try {
      const contents = readClaudeManagedAuthFile(managedAuthPath, 'oauth-account.json')
      return contents ? (JSON.parse(contents) as unknown) : null
    } catch {
      return null
    }
  }

  protected async getOwnedManagedAuthPath(account: ClaudeManagedAccount): Promise<string | null> {
    const wslInfo = parseWslUncPath(account.managedAuthPath)
    if (wslInfo) {
      if (
        !wslInfo.linuxPath.includes('/.local/share/orca/claude-accounts/') ||
        !wslInfo.linuxPath.endsWith('/auth')
      ) {
        return null
      }
      if (process.platform === 'win32') {
        try {
          const owned = await runWslProcess({
            distro: wslInfo.distro,
            loginPath: 'none',
            shell: 'bash',
            script: [
              'set -euo pipefail',
              `candidate=${shellQuote(wslInfo.linuxPath)}`,
              'managed_root="${HOME%/}/.local/share/orca/claude-accounts"',
              'candidate_real=$(readlink -f -- "$candidate")',
              'managed_root_real=$(readlink -f -- "$managed_root")',
              'test -f "$candidate_real/.orca-managed-claude-auth"',
              `test "$(cat "$candidate_real/.orca-managed-claude-auth")" = ${shellQuote(account.id)}`,
              'case "$candidate_real" in "$managed_root_real"/*/auth) printf "%s\\n" "$candidate_real" ;; *) exit 35 ;; esac'
            ].join('\n'),
            timeoutMs: 5000
          })
          if (owned.timedOut) {
            throw new Error(OWNERSHIP_PROBE_TIMEOUT)
          }
          if (owned.code !== 0) {
            return null
          }
          const canonicalLinuxPath = owned.stdout.trim()
          return canonicalLinuxPath ? toWindowsWslPath(canonicalLinuxPath, wslInfo.distro) : null
        } catch (error) {
          // Why rethrow a timeout: null means "not owned by Orca", and the
          // caller persists that -- clearing the user's account selection. A
          // slow distro must not decide ownership. Swallowing it here is what
          // made the previous guard dead code.
          if (error instanceof Error && error.message === OWNERSHIP_PROBE_TIMEOUT) {
            throw error
          }
          return null
        }
      }
      return existsSync(account.managedAuthPath) ? account.managedAuthPath : null
    }
    try {
      const verdict = resolveClaudeManagedAuthOwnership(account.id, account.managedAuthPath)
      if (verdict.kind === 'indeterminate') {
        throw new ClaudeManagedAuthTemporarilyUnavailableError({ cause: verdict.error })
      }
      return verdict.kind === 'owned'
        ? verdict.authPath
        : resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
            adoptLegacyMarker: true
          })
    } catch (error) {
      if (error instanceof ClaudeManagedAuthTemporarilyUnavailableError) {
        throw error
      }
      return null
    }
  }
}
