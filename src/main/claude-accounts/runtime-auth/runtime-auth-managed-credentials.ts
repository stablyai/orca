import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  assertOwnedClaudeManagedAuthPath,
  type ClaudeManagedAuthVerdict
} from '../claude-managed-auth-ownership'
import {
  readClaudeManagedAuthFileResult,
  resolveClaudeManagedAuthVerdict,
  writeClaudeManagedAuthFile,
  type ClaudeManagedAuthFileRead
} from '../managed-auth-path'
import { resolveWslManagedAuthVerdict } from '../wsl-managed-auth-probe'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from '../oauth-refresh'
import {
  readManagedClaudeKeychainCredentials,
  writeManagedClaudeKeychainCredentials
} from '../keychain'
import { ClaudeRuntimeAuthCredentialIdentity } from './runtime-auth-credential-identity'

/**
 * Why this needs a result too: the null it replaces is the third disjunct of the
 * decision that restores the user's system default before Orca clears a managed
 * selection. A failed read made that disjunct false, so no restore ran and the
 * selection was cleared anyway -- the runtime kept holding managed credentials
 * for an account Orca had forgotten.
 */
export type ClaudeManagedOauthRead =
  | { kind: 'present'; value: unknown }
  | { kind: 'absent' }
  | { kind: 'indeterminate'; error: unknown }

export class ClaudeRuntimeAuthManagedCredentials extends ClaudeRuntimeAuthCredentialIdentity {
  protected async readManagedCredentials(account: ClaudeManagedAccount): Promise<string | null> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    return managedAuthPath === null ? null : this.readManagedCredentialsAt(account, managedAuthPath)
  }

  /**
   * Why a separate entry point: the caller that already holds a proven verdict
   * must not re-probe. A second probe can fail where the first succeeded, and
   * `null` from it reaches `doSyncForCurrentSelection` as "missing credentials",
   * which clears the user's selection (STA-5674).
   */
  protected async readManagedCredentialsAt(
    account: ClaudeManagedAccount,
    managedAuthPath: string
  ): Promise<string | null> {
    const read = await this.readManagedCredentialsResultAt(account, managedAuthPath)
    return read.kind === 'present' ? read.contents : null
  }

  /**
   * The unflattened read, for the caller that clears the user's selection when
   * credentials look missing. A locked file is not a missing one.
   */
  protected async readManagedCredentialsResultAt(
    account: ClaudeManagedAccount,
    managedAuthPath: string
  ): Promise<ClaudeManagedAuthFileRead> {
    if (process.platform === 'darwin') {
      try {
        const contents = await readManagedClaudeKeychainCredentials(account.id)
        return contents === null ? { kind: 'absent' } : { kind: 'present', contents }
      } catch (error) {
        // The keychain helper resolves null only for a genuine not-found; every
        // other failure throws, and none of them are an absent credential.
        return { kind: 'indeterminate', error }
      }
    }
    return readClaudeManagedAuthFileResult(managedAuthPath, '.credentials.json')
  }

  protected async writeManagedCredentials(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    const managedAuthPath = assertOwnedClaudeManagedAuthPath(
      await this.resolveManagedAuthVerdict(account)
    )
    if (process.platform === 'darwin') {
      await writeManagedClaudeKeychainCredentials(account.id, credentialsJson)
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
    const read = await this.readManagedOauthAccountResult(account)
    return read.kind === 'present' ? read.value : null
  }

  protected async readManagedOauthAccountResult(
    account: ClaudeManagedAccount
  ): Promise<ClaudeManagedOauthRead> {
    const verdict = await this.resolveManagedAuthVerdict(account)
    if (verdict.kind === 'indeterminate') {
      return { kind: 'indeterminate', error: verdict.error }
    }
    if (verdict.kind === 'untrusted') {
      return { kind: 'absent' }
    }
    const read = readClaudeManagedAuthFileResult(verdict.authPath, 'oauth-account.json')
    if (read.kind !== 'present') {
      return read
    }
    try {
      return { kind: 'present', value: JSON.parse(read.contents) as unknown }
    } catch {
      // Malformed JSON is a completed observation of the file, not a failure to
      // read it.
      return { kind: 'absent' }
    }
  }

  protected async getOwnedManagedAuthPath(account: ClaudeManagedAccount): Promise<string | null> {
    const verdict = await this.resolveManagedAuthVerdict(account)
    return verdict.kind === 'owned' ? verdict.authPath : null
  }

  /**
   * The ownership question, unflattened. Callers that clear the user's active
   * account must branch on this rather than on `getOwnedManagedAuthPath`'s null,
   * which cannot tell a stranger's directory from a distro that would not start.
   */
  protected async resolveManagedAuthVerdict(
    account: ClaudeManagedAccount
  ): Promise<ClaudeManagedAuthVerdict> {
    const wslInfo = parseWslUncPath(account.managedAuthPath)
    if (wslInfo) {
      return resolveWslManagedAuthVerdict(account.managedAuthPath, wslInfo, account.id)
    }
    return resolveClaudeManagedAuthVerdict(account.id, account.managedAuthPath, {
      adoptLegacyMarker: true
    })
  }
}
