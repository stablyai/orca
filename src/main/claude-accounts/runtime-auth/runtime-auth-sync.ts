import { existsSync, readFileSync } from 'node:fs'
import {
  getSelectedClaudeAccountIdForTarget,
  normalizeClaudeAccountSelectionTarget,
  type ClaudeAccountSelectionTarget
} from '../runtime-selection'
import { hasLiveClaudePtys } from '../live-pty-gate'
import { isOauthTokenExpiring } from '../oauth-refresh'
import { writeActiveClaudeKeychainCredentialsForRuntime } from '../keychain'
import { ClaudeRuntimeAuthPreparationService } from './runtime-auth-preparation'
import type { ClaudeManagedAccount } from '../../../shared/managed-account-types'
import type { ClaudeManagedOauthRead } from './runtime-auth-managed-credentials'
import {
  clearClaudeSelectionForTarget,
  shouldDeferOnUnreadableOauth
} from './runtime-auth-selection-teardown'

export class ClaudeRuntimeAuthSync extends ClaudeRuntimeAuthPreparationService {
  protected async doSyncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    const settings = this.store.getSettings()
    const effectiveTarget = this.resolveWslDefaultTarget(target)
    const normalizedTarget = normalizeClaudeAccountSelectionTarget(effectiveTarget)
    const activeAccountId = getSelectedClaudeAccountIdForTarget(settings, normalizedTarget)
    const activeAccount = this.getActiveAccount(settings.claudeManagedAccounts, activeAccountId)
    const previousAccount = this.getActiveAccount(
      settings.claudeManagedAccounts,
      this.lastSyncedAccountId
    )
    this.managedRefreshDeferredByLivePtyAccountId = null
    const previousManagedCredentialsJson = previousAccount
      ? await this.readManagedCredentials(previousAccount)
      : null
    const previousManagedOauthRead = previousAccount
      ? await this.readManagedOauthAccountResult(previousAccount)
      : null
    const previousManagedOauthAccount =
      previousManagedOauthRead?.kind === 'present' ? previousManagedOauthRead.value : null
    if (previousAccount && previousAccount.id !== activeAccount?.id) {
      if (previousManagedCredentialsJson) {
        const outgoingReadBackResult = await this.readBackRefreshedTokens(
          previousManagedCredentialsJson,
          {
            updateLastWrittenCredentialsJson: true
          }
        )
        if (
          outgoingReadBackResult.status === 'rejected' &&
          outgoingReadBackResult.runtimeCredentialsChanged &&
          hasLiveClaudePtys()
        ) {
          if (
            outgoingReadBackResult.runtimeCredentialsJson &&
            this.liveRuntimeCredentialsCanUpdateActiveAccount(
              outgoingReadBackResult.runtimeCredentialsJson,
              previousAccount,
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          ) {
            // Why: switching away while Claude is live must preserve verified token refreshes before replacing shared runtime credentials.
            await this.writeManagedCredentials(
              previousAccount,
              outgoingReadBackResult.runtimeCredentialsJson
            )
          } else {
            // Why: the runtime blob may lack identity proof for a live-session refresh; skip persisting it, but still let new terminals move to the account.
            console.warn(
              '[claude-runtime-auth] Skipping unverified live Claude auth read-back while switching accounts'
            )
          }
        }
      }
    }
    if (!activeAccount) {
      if (activeAccountId) {
        clearClaudeSelectionForTarget(this.store, settings, normalizedTarget)
      }
      if (normalizedTarget.runtime === 'wsl') {
        return
      }
      if (this.lastSyncedAccountId !== null) {
        await (previousAccount
          ? this.restoreSystemDefaultSnapshot(
              previousManagedCredentialsJson,
              previousManagedOauthAccount
            )
          : this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined))
        this.lastSyncedAccountId = null
      }
      return
    }

    if (activeAccount.managedAuthRuntime === 'wsl') {
      const wslOwnership = await this.resolveManagedAuthVerdict(activeAccount)
      if (wslOwnership.kind === 'indeterminate') {
        // Why return rather than clear: a distro that would not start, or a
        // probe that timed out, is not evidence about the account. Clearing here
        // is how a cold distro used to log the user out (STA-5674).
        console.warn(
          '[claude-runtime-auth] Could not verify the active WSL managed account; leaving the selection in place',
          wslOwnership.error
        )
        return
      }
      if (wslOwnership.kind === 'untrusted') {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is not owned by Orca, restoring system default'
        )
        clearClaudeSelectionForTarget(this.store, settings, normalizedTarget)
        return
      }
      const wslCredentials = await this.readManagedCredentialsResultAt(
        activeAccount,
        wslOwnership.authPath
      )
      if (wslCredentials.kind === 'indeterminate') {
        console.warn(
          '[claude-runtime-auth] Could not read the active WSL managed credentials; leaving the selection in place',
          wslCredentials.error
        )
        return
      }
      const credentialsJson = wslCredentials.kind === 'present' ? wslCredentials.contents : null
      if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
        console.warn(
          '[claude-runtime-auth] Active WSL managed account is missing or has invalid credentials, restoring system default'
        )
        clearClaudeSelectionForTarget(this.store, settings, normalizedTarget)
        return
      }
      // Why: WSL managed accounts are isolated by their Linux CLAUDE_CONFIG_DIR; materializing into Windows ~/.claude would mix two auth stores.
      this.clearLastWrittenRuntimeState()
      return
    }

    const hostOwnership = await this.resolveManagedAuthVerdict(activeAccount)
    if (hostOwnership.kind === 'indeterminate') {
      console.warn(
        '[claude-runtime-auth] Could not verify the active managed account; leaving the selection in place',
        hostOwnership.error
      )
      return
    }
    if (hostOwnership.kind === 'untrusted') {
      console.warn(
        '[claude-runtime-auth] Active managed account is not owned by Orca, restoring system default'
      )
      await this.restoreDefaultAndDropHostSelection(
        activeAccount,
        previousAccount,
        previousManagedOauthRead,
        previousManagedOauthAccount
      )
      return
    }

    const hostCredentials = await this.readManagedCredentialsResultAt(
      activeAccount,
      hostOwnership.authPath
    )
    if (hostCredentials.kind === 'indeterminate') {
      console.warn(
        '[claude-runtime-auth] Could not read the active managed credentials; leaving the selection in place',
        hostCredentials.error
      )
      return
    }
    let credentialsJson = hostCredentials.kind === 'present' ? hostCredentials.contents : null
    if (!credentialsJson || !this.isValidCredentialsJsonObject(credentialsJson)) {
      console.warn(
        '[claude-runtime-auth] Active managed account is missing or has invalid credentials, restoring system default'
      )
      await this.restoreDefaultAndDropHostSelection(
        activeAccount,
        previousAccount,
        previousManagedOauthRead,
        previousManagedOauthAccount
      )
      return
    }

    if (this.lastSyncedAccountId === null) {
      const paths = this.pathResolver.getRuntimePaths()
      const runtimeCredentialsJson = existsSync(paths.credentialsPath)
        ? readFileSync(paths.credentialsPath, 'utf-8')
        : null
      await this.captureSystemDefaultSnapshotForManagedEntry(
        runtimeCredentialsJson,
        credentialsJson
      )
    }

    // Why: the CLI writes refreshed tokens to .credentials.json; if runtime differs from our last write, preserve them to managed storage before overwriting.
    if (this.lastSyncedAccountId === activeAccount.id) {
      if (this.skipNextReadBackForAccountId === activeAccount.id) {
        this.skipNextReadBackForAccountId = null
      } else {
        const readBackResult = await this.readBackRefreshedTokens(credentialsJson, {
          updateLastWrittenCredentialsJson: true
        })
        if (readBackResult.status === 'persisted') {
          const updatedCredentialsJson = await this.readManagedCredentials(activeAccount)
          if (updatedCredentialsJson && this.isValidCredentialsJsonObject(updatedCredentialsJson)) {
            credentialsJson = updatedCredentialsJson
          }
        } else if (
          readBackResult.status === 'rejected' &&
          readBackResult.runtimeCredentialsChanged &&
          // Why: a live Claude that lost a refresh race can wipe its runtime blob (empty tokens); preserving that would log out every new session.
          readBackResult.hasValidChangedRuntimeCredentials &&
          hasLiveClaudePtys()
        ) {
          if (
            readBackResult.runtimeCredentialsJson &&
            this.liveRuntimeCredentialsCanUpdateActiveAccount(
              readBackResult.runtimeCredentialsJson,
              activeAccount,
              credentialsJson,
              await this.readManagedOauthAccount(activeAccount)
            )
          ) {
            // Why: this Claude launched under the active managed account, but persistence still needs positive account proof.
            await this.writeManagedCredentials(activeAccount, readBackResult.runtimeCredentialsJson)
            credentialsJson = readBackResult.runtimeCredentialsJson
          } else {
            // Why: while Claude runs, an unknown refresh may belong to a live session; rewriting stale managed auth logs it out.
            console.warn(
              '[claude-runtime-auth] Preserving changed Claude runtime credentials while live Claude terminals are running'
            )
            this.lastSyncedAccountId = activeAccount.id
            this.hasMaterializedRuntimeAuth = true
            return
          }
        }
      }
    }

    if (this.lastSyncedAccountId !== activeAccount.id) {
      this.skipNextReadBackForAccountId = null
    }

    // Why: rotate+persist the single-use token to managed storage before materializing (else runtime gets a stale token that fails invalid_grant); skip while a live PTY owns the creds since refreshing would double-rotate it (invalidating one copy) — read-back preserves its refresh instead.
    const liveClaudePtys = hasLiveClaudePtys()
    if (liveClaudePtys && isOauthTokenExpiring(credentialsJson)) {
      this.managedRefreshDeferredByLivePtyAccountId = activeAccount.id
    }
    if (!liveClaudePtys) {
      const refreshed = await this.refreshManagedAccountTokenIfNeeded(
        activeAccount,
        credentialsJson
      )
      if (refreshed) {
        credentialsJson = refreshed
      }
    }

    const paths = this.pathResolver.getRuntimePaths()
    this.writeRuntimeCredentials(credentialsJson)
    if (process.platform === 'darwin') {
      // Why: Claude Code 2.1+ reads the scoped service, older builds the legacy unsuffixed one; runtime switching must satisfy both.
      try {
        await writeActiveClaudeKeychainCredentialsForRuntime(credentialsJson, paths.configDir)
      } catch (error) {
        await this.restoreSystemDefaultSnapshot(
          credentialsJson,
          await this.readManagedOauthAccount(activeAccount)
        )
        throw error
      }
    }
    const managedOauthAccount = await this.readManagedOauthAccount(activeAccount)
    if (this.writeRuntimeOauthAccount(managedOauthAccount)) {
      this.lastWrittenOauthAccount = managedOauthAccount
      this.hasLastWrittenOauthAccount = true
    } else {
      this.lastWrittenOauthAccount = null
      this.hasLastWrittenOauthAccount = false
    }
    this.lastSyncedAccountId = activeAccount.id
    this.hasMaterializedRuntimeAuth = true
  }

  /**
   * Undo the managed materialization, if we can establish that it happened, then
   * drop the host selection. When the oauth identity cannot be read this does
   * nothing at all -- neither the restore nor the clear -- so the next sync
   * retries the whole transition rather than completing half of it.
   */
  private async restoreDefaultAndDropHostSelection(
    activeAccount: ClaudeManagedAccount,
    previousAccount: ClaudeManagedAccount | null,
    previousManagedOauthRead: ClaudeManagedOauthRead | null,
    previousManagedOauthAccount: unknown
  ): Promise<void> {
    if (this.lastSyncedAccountId !== null) {
      if (shouldDeferOnUnreadableOauth(previousManagedOauthRead)) {
        return
      }
      if (
        previousAccount &&
        (previousAccount.id !== activeAccount.id ||
          this.hasMaterializedRuntimeAuth ||
          this.runtimeOauthAccountMatches(previousManagedOauthAccount))
      ) {
        await this.restoreSystemDefaultSnapshotForMissingManagedCredentials(
          previousAccount,
          previousManagedOauthAccount
        )
      } else if (!previousAccount && this.hasMaterializedRuntimeAuth) {
        await this.restoreSystemDefaultSnapshot(this.lastWrittenCredentialsJson, undefined)
      }
    }
    this.store.updateSettings({ activeClaudeManagedAccountId: null })
    this.lastSyncedAccountId = null
  }
}
