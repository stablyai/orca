import { existsSync, readFileSync, rmSync } from 'node:fs'
import { ClaudeRuntimeAuthReadback } from './runtime-auth-readback'
import {
  RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR,
  type ClaudeSystemDefaultSnapshot
} from './runtime-auth-types'

export class ClaudeRuntimeAuthSnapshotCapture extends ClaudeRuntimeAuthReadback {
  protected async captureSystemDefaultSnapshotForManagedEntry(
    runtimeCredentialsJson: string | null,
    managedCredentialsJson: string
  ): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    const existingSnapshot = this.readSystemDefaultSnapshot(snapshotPath)
    if (runtimeCredentialsJson !== managedCredentialsJson) {
      await this.captureSystemDefaultSnapshot({
        force: true,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
      return
    }
    if (existingSnapshot) {
      await this.captureSystemDefaultSnapshot({
        force: true,
        credentialsJsonOverride: existingSnapshot.credentialsJson,
        previousSnapshot: existingSnapshot,
        managedCredentialsJson
      })
      return
    }
    await this.captureSystemDefaultSnapshot({ force: false })
  }

  protected async captureSystemDefaultSnapshot(options: {
    force: boolean
    credentialsJsonOverride?: string | null
    previousSnapshot?: ClaudeSystemDefaultSnapshot | null
    managedCredentialsJson?: string
  }): Promise<void> {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    if (!options.force && existsSync(snapshotPath)) {
      return
    }

    const paths = this.pathResolver.getRuntimePaths()
    const credentialsJson =
      options.credentialsJsonOverride !== undefined
        ? options.credentialsJsonOverride
        : existsSync(paths.credentialsPath)
          ? readFileSync(paths.credentialsPath, 'utf-8')
          : null
    const keychainCredentialsJson = await this.readAggregateClaudeKeychainCredentialsBestEffort(
      paths.configDir
    )
    const scopedKeychainCredentials =
      process.platform === 'darwin'
        ? await this.readActiveClaudeKeychainCredentialsForSnapshot(paths.configDir)
        : ({ status: 'captured', credentialsJson: null } as const)
    const legacyKeychainCredentialsJson =
      process.platform === 'darwin'
        ? await this.readActiveClaudeKeychainCredentialsForSnapshot()
        : ({ status: 'captured', credentialsJson: null } as const)
    if (
      scopedKeychainCredentials.status === 'failed' ||
      legacyKeychainCredentialsJson.status === 'failed'
    ) {
      throw new Error('Cannot capture current Claude Keychain credentials')
    }
    const scopedKeychainCredentialsJson =
      scopedKeychainCredentials.status === 'captured'
        ? this.snapshotKeychainCredentials(
            scopedKeychainCredentials.credentialsJson,
            options.previousSnapshot,
            'scoped',
            options.managedCredentialsJson
          )
        : undefined
    const legacyKeychainSnapshotJson =
      legacyKeychainCredentialsJson.status === 'captured'
        ? this.snapshotKeychainCredentials(
            legacyKeychainCredentialsJson.credentialsJson,
            options.previousSnapshot,
            'legacy',
            options.managedCredentialsJson
          )
        : undefined
    const configOauthAccount = this.readRuntimeOauthAccount()
    const snapshot: ClaudeSystemDefaultSnapshot = {
      credentialsJson,
      configOauthAccount:
        configOauthAccount === RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR ? null : configOauthAccount,
      configPath: paths.configPath,
      keychainCredentialsJson,
      scopedKeychainCredentialsJson,
      legacyKeychainCredentialsJson: legacyKeychainSnapshotJson,
      scopedKeychainCredentialsCaptured: scopedKeychainCredentials.status === 'captured',
      legacyKeychainCredentialsCaptured: legacyKeychainCredentialsJson.status === 'captured',
      capturedAt: Date.now()
    }
    this.writeJson(snapshotPath, snapshot)
  }

  /**
   * Clears the system-default oauthAccount when the snapshot came from another config file.
   *
   * Why: older resolvers read ~/.claude/.claude.json whenever it existed, although Claude
   * without CLAUDE_CONFIG_DIR only reads ~/.claude.json, and snapshots did not record their
   * source, so the value may belong to a file Claude never read. Nothing on disk proves which
   * identity was the system's, so it is treated as unknown: restore removes oauthAccount and
   * Claude repopulates it from its token's profile on next start. Runs before any runtime
   * mutation so a rollback can never restore the unreconciled value.
   */
  protected reconcileSystemDefaultSnapshotConfigPath(): void {
    const snapshotPath = this.getSystemDefaultSnapshotPath()
    // Why: invalid snapshots stay for the restore paths that own their cleanup.
    const snapshot = this.peekSystemDefaultSnapshot(snapshotPath)
    const { configPath } = this.pathResolver.getRuntimePaths()
    if (!snapshot || snapshot.configPath === configPath) {
      return
    }
    this.writeJson(snapshotPath, { ...snapshot, configPath, configOauthAccount: null })
  }

  private peekSystemDefaultSnapshot(snapshotPath: string): ClaudeSystemDefaultSnapshot | null {
    if (!existsSync(snapshotPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown
      return this.isSystemDefaultSnapshot(parsed) ? parsed : null
    } catch {
      // Why: an unparsable snapshot is reported and removed by readSystemDefaultSnapshot.
      return null
    }
  }

  protected readSystemDefaultSnapshot(snapshotPath: string): ClaudeSystemDefaultSnapshot | null {
    if (!existsSync(snapshotPath)) {
      return null
    }
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as unknown
      if (this.isSystemDefaultSnapshot(parsed)) {
        return parsed
      }
      throw new Error('Invalid Claude system-default auth snapshot shape')
    } catch (error) {
      console.warn('[claude-runtime-auth] Ignoring invalid system-default auth snapshot:', error)
      rmSync(snapshotPath, { force: true })
      return null
    }
  }
}
