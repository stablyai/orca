import { existsSync } from 'node:fs'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { toWindowsWslPath } from '../../wsl'
import { runWslProcess } from '../../wsl/wsl-runner'
import {
  readClaudeManagedAuthFile,
  resolveOwnedClaudeManagedAuthPath,
  writeClaudeManagedAuthFile
} from '../managed-auth-path'
import { isOauthTokenExpiring, refreshClaudeOauthCredentials } from '../oauth-refresh'
import {
  readClaudeAccountCredentials,
  writeClaudeAccountCredentials,
  hasIsolatedClaudeAccountAuth
} from '../isolated-account-auth'
import { ClaudeRuntimeAuthCredentialIdentity } from './runtime-auth-credential-identity'
import { stripSharedClaudeCredentialFields } from '../shared-credential-fields'

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
    if (process.platform === 'darwin') {
      const credentials = await readClaudeAccountCredentials({
        accountId: account.id,
        managedAuthPath
      })
      return credentials === null || hasIsolatedClaudeAccountAuth(managedAuthPath)
        ? credentials
        : stripSharedClaudeCredentialFields(credentials)
    }
    const credentials = readClaudeManagedAuthFile(managedAuthPath, '.credentials.json')
    return credentials === null ||
      account.managedAuthRuntime === 'wsl' ||
      hasIsolatedClaudeAccountAuth(managedAuthPath)
      ? credentials
      : stripSharedClaudeCredentialFields(credentials)
  }

  protected async writeManagedCredentials(
    account: ClaudeManagedAccount,
    credentialsJson: string
  ): Promise<void> {
    const managedAuthPath = await this.getOwnedManagedAuthPath(account)
    if (!managedAuthPath) {
      throw new Error('Managed Claude auth storage is not owned by Orca.')
    }
    if (account.managedAuthRuntime !== 'wsl' && !hasIsolatedClaudeAccountAuth(managedAuthPath)) {
      credentialsJson = stripSharedClaudeCredentialFields(credentialsJson)
    }
    if (process.platform === 'darwin') {
      await writeClaudeAccountCredentials(
        { accountId: account.id, managedAuthPath },
        credentialsJson
      )
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
    return resolveOwnedClaudeManagedAuthPath(account.id, account.managedAuthPath, {
      adoptLegacyMarker: true
    })
  }
}
