import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import {
  countClaudePinnedAccountUsers,
  releaseClaudePinnedAccountReservation,
  reserveClaudePinnedAccount
} from '../claude-pinned-pty-registry'
import {
  clearPinnedClaudeKeychainCredentials,
  hashClaudeCredentialsJson,
  readPinnedClaudeKeychainCredentials,
  readPinnedClaudeSeedMarker,
  seedPinnedClaudeKeychainCredentials
} from '../claude-pinned-credentials'
import { prepareClaudePinnedConfigDir } from '../claude-pinned-config-dir'
import {
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import { ClaudeRuntimeAuthPreparationService } from './runtime-auth-preparation'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-types'

/**
 * A launch pinned to a managed host account that is NOT the host's active one.
 *
 * It never goes through the global sync: the host's `~/.claude` keeps the active account, and the
 * pinned Claude gets the managed auth dir itself as CLAUDE_CONFIG_DIR — the same shape the WSL
 * path and the inactive usage preview already use. On Linux and Windows that dir's
 * `.credentials.json` IS the managed store, so Claude refreshes it in place. On macOS Claude only
 * reads the Keychain item scoped to that dir, so the managed blob is seeded into it and read back
 * once the account's last pinned PTY exits.
 *
 * Refresh tokens are single-use: replaying a spent one revokes the whole token family. So an
 * account is only ever refreshed through one store at a time — never materialized as the host
 * account while pinned (selection refuses), never refreshed by Orca while a pinned Claude may hold
 * it (the usage fetcher checks the registry), and read back only with identity proof.
 */
export class ClaudeRuntimeAuthPinnedLaunch extends ClaudeRuntimeAuthPreparationService {
  /** Caller holds the mutation queue. Reserves the account; the spawn releases the reservation. */
  protected async preparePinnedClaudeLaunch(
    account: ClaudeManagedAccount,
    target: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    if (normalizeClaudeAccountSelectionTarget(target).runtime !== 'host') {
      throw new Error('Claude --account launches are not supported for WSL terminals yet.')
    }
    if (account.managedAuthRuntime === 'wsl') {
      throw new Error(
        `Claude account ${account.email} is a WSL account; --account supports host accounts only.`
      )
    }
    const configDir = await this.getOwnedManagedAuthPath(account)
    if (!configDir) {
      throw new Error(
        `Orca cannot verify the saved sign-in for Claude account ${account.email}. Re-authenticate it in Settings > Accounts, then retry.`
      )
    }
    // Why before reserving: any other holder means a pinned Claude may already own the scoped
    // item, and reseeding it would roll that session back to a spent refresh token.
    const sharedWithLiveSession = countClaudePinnedAccountUsers(account.id) > 0
    reserveClaudePinnedAccount(account.id)
    try {
      if (process.platform === 'darwin' && !sharedWithLiveSession) {
        await this.reconcilePinnedKeychainCredentials(account, configDir, { strict: true })
      }
      const credentialsJson = await this.readManagedCredentials(account)
      if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
        throw new Error(
          `Claude account ${account.email} has no valid saved sign-in. Re-authenticate it in Settings > Accounts, then retry.`
        )
      }
      if (process.platform === 'darwin' && !sharedWithLiveSession) {
        await seedPinnedClaudeKeychainCredentials({
          accountId: account.id,
          configDir,
          credentialsJson
        })
      }
      const hostPaths = this.pathResolver.getRuntimePaths()
      try {
        prepareClaudePinnedConfigDir({
          configDir,
          source: { hostConfigDir: hostPaths.configDir, hostConfigPath: hostPaths.configPath },
          oauthAccount: await this.readManagedOauthAccount(account)
        })
      } catch (error) {
        // Why: the mirror only spares prompts; a launch that still authenticates is better than none.
        console.warn(
          '[claude-runtime-auth] Could not mirror host config for a pinned launch:',
          error
        )
      }
      return {
        configDir,
        runtime: 'host',
        wslDistro: null,
        wslLinuxConfigDir: null,
        envPatch: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir },
        stripAuthEnv: true,
        pinnedAccountId: account.id,
        provenance: `managed:${account.id}:pinned`
      }
    } catch (error) {
      releaseClaudePinnedAccountReservation(account.id)
      throw error
    }
  }

  /**
   * Takes a seeded scoped Keychain item back into the managed store (macOS only).
   *
   * Adopts only when the managed store still holds exactly what was seeded — a re-auth in between
   * wins — and the scoped blob is a valid, not-older credential for this same account. Either way
   * the scoped copy and its marker are then removed; a read or delete that fails keeps the marker
   * so the next launch or startup retries rather than seeding over an unread refresh.
   */
  protected async reconcilePinnedKeychainCredentials(
    account: ClaudeManagedAccount,
    configDir: string,
    options: { strict: boolean }
  ): Promise<void> {
    const seededHash = readPinnedClaudeSeedMarker(configDir)
    if (seededHash === null) {
      return
    }
    let scopedCredentialsJson: string | null
    try {
      scopedCredentialsJson = await readPinnedClaudeKeychainCredentials(configDir)
    } catch (error) {
      if (options.strict) {
        throw new Error(
          'Could not read the Keychain item of the last Claude session pinned to this account. Unlock the Keychain and retry.',
          { cause: error }
        )
      }
      console.warn('[claude-runtime-auth] Deferring pinned Claude read-back:', error)
      return
    }
    const managedCredentialsJson = await this.readManagedCredentials(account)
    if (
      scopedCredentialsJson &&
      managedCredentialsJson &&
      scopedCredentialsJson !== managedCredentialsJson &&
      hashClaudeCredentialsJson(managedCredentialsJson) === seededHash &&
      this.isValidCredentialsJsonObject(scopedCredentialsJson) &&
      !this.runtimeCredentialsAreOlder(scopedCredentialsJson, managedCredentialsJson) &&
      this.runtimeCredentialsMatchAccount(
        scopedCredentialsJson,
        this.readPinnedConfigOauthAccount(configDir),
        account,
        managedCredentialsJson,
        await this.readManagedOauthAccount(account)
      ) === 'match'
    ) {
      await this.writeManagedCredentials(account, scopedCredentialsJson)
    }
    try {
      await clearPinnedClaudeKeychainCredentials(account.id, configDir)
    } catch (error) {
      if (options.strict) {
        throw error
      }
      console.warn('[claude-runtime-auth] Could not remove a pinned Claude Keychain copy:', error)
    }
  }

  private readPinnedConfigOauthAccount(configDir: string): unknown {
    const config = this.readJsonObject(join(configDir, '.claude.json'))
    return config?.oauthAccount ?? null
  }
}
