import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { Store } from '../persistence'
import {
  getSelectedClaudeAccountIdForTarget,
  type ClaudeAccountSelectionTarget
} from './runtime-selection'
import { ClaudeRuntimeAuthSync } from './runtime-auth/runtime-auth-sync'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

export class ClaudeRuntimeAuthService extends ClaudeRuntimeAuthSync {
  constructor(store: Store) {
    super(store)
    this.initializeLastSyncedState()
    void this.safeSyncForCurrentSelection()
  }

  async prepareForClaudeLaunch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async prepareForRateLimitFetch(
    target?: ClaudeAccountSelectionTarget
  ): Promise<ClaudeRuntimeAuthPreparation> {
    const effectiveTarget = target ?? this.getDefaultAccountSelectionTarget()
    await this.syncForCurrentSelection(effectiveTarget)
    return this.getPreparation(effectiveTarget)
  }

  async syncForCurrentSelection(target?: ClaudeAccountSelectionTarget): Promise<void> {
    await this.serializeMutation(() =>
      this.doSyncForCurrentSelection(target ?? this.getDefaultAccountSelectionTarget())
    )
  }

  async forceMaterializeCurrentSelectionForRollback(): Promise<void> {
    await this.serializeMutation(async () => {
      const settings = this.store.getSettings()
      if (!settings.activeClaudeManagedAccountId) {
        const previousAccount = this.getActiveAccount(
          settings.claudeManagedAccounts,
          this.lastSyncedAccountId
        )
        await this.restoreSystemDefaultSnapshot(
          previousAccount ? await this.readManagedCredentials(previousAccount) : null,
          previousAccount ? await this.readManagedOauthAccount(previousAccount) : undefined
        )
        this.lastSyncedAccountId = null
        return
      }
      await this.doSyncForCurrentSelection()
    })
  }

  getRuntimeConfigDir(target?: ClaudeAccountSelectionTarget): string {
    return this.getPreparation(target).configDir
  }

  private initializeLastSyncedState(): void {
    const settings = this.store.getSettings()
    this.lastSyncedAccountId = getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
  }

  private async safeSyncForCurrentSelection(): Promise<void> {
    try {
      await this.syncForCurrentSelection()
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to sync runtime auth state:', error)
    }
  }

  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn)
    this.mutationQueue = next.catch(() => {})
    return next
  }

  // Why: re-auth/add-account write fresh managed tokens; skip the next read-back so stale runtime tokens can't overwrite them.
  clearLastWrittenCredentialsJson(
    accountId = this.store.getSettings().activeClaudeManagedAccountId
  ): void {
    if (accountId === this.store.getSettings().activeClaudeManagedAccountId) {
      this.lastWrittenCredentialsJson = null
    }
    this.skipNextReadBackForAccountId = accountId
  }

  private getConsoleCredentialPath(): string {
    return join(this.getRuntimeMetadataDir(), 'console-api-key.enc')
  }

  async getConsoleCredential(): Promise<string | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return null
      }
      const credentialPath = this.getConsoleCredentialPath()
      if (!existsSync(credentialPath)) {
        return null
      }
      const encrypted = readFileSync(credentialPath, 'utf-8')
      return safeStorage.decryptString(Buffer.from(encrypted, 'hex'))
    } catch (error) {
      console.warn('Failed to retrieve console credential:', error)
      return null
    }
  }

  async setConsoleCredential(apiKey: string): Promise<void> {
    if (!apiKey) {
      throw new Error('API key cannot be empty')
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('System credential storage unavailable')
    }
    try {
      const encrypted = safeStorage.encryptString(apiKey)
      const credentialPath = this.getConsoleCredentialPath()
      mkdirSync(dirname(credentialPath), { recursive: true })
      // Why: writeFileSync's mode only applies when creating, so an existing 0o644
      // credential would keep it; the atomic rename always lands a fresh 0o600 file.
      writeFileAtomically(credentialPath, encrypted.toString('hex'), { mode: 0o600 })
    } catch (error) {
      throw new Error(`Failed to store console credential: ${(error as Error).message}`)
    }
  }

  async clearConsoleCredential(): Promise<void> {
    try {
      rmSync(this.getConsoleCredentialPath(), { force: true })
    } catch (error) {
      console.warn('Failed to clear console credential:', error)
    }
  }
}
