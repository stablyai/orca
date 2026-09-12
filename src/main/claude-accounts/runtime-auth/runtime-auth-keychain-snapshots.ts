import {
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict
} from '../keychain'
import { ClaudeRuntimeAuthManagedCredentials } from './runtime-auth-managed-credentials'
import type {
  ClaudeKeychainReadResult,
  ClaudeKeychainSnapshotValue,
  ClaudeSystemDefaultSnapshot
} from './runtime-auth-types'

export class ClaudeRuntimeAuthKeychainSnapshots extends ClaudeRuntimeAuthManagedCredentials {
  protected isSystemDefaultSnapshot(value: unknown): value is ClaudeSystemDefaultSnapshot {
    const snapshot = this.asRecord(value)
    return (
      snapshot !== null &&
      Object.hasOwn(snapshot, 'credentialsJson') &&
      this.isOptionalNullableString(snapshot.credentialsJson) &&
      this.isOptionalNullableString(snapshot.keychainCredentialsJson) &&
      this.isOptionalNullableString(snapshot.scopedKeychainCredentialsJson) &&
      this.isOptionalNullableString(snapshot.legacyKeychainCredentialsJson) &&
      this.isOptionalBoolean(snapshot.scopedKeychainCredentialsCaptured) &&
      this.isOptionalBoolean(snapshot.legacyKeychainCredentialsCaptured) &&
      this.hasValidKeychainSnapshotValue(snapshot, 'scoped') &&
      this.hasValidKeychainSnapshotValue(snapshot, 'legacy') &&
      (snapshot.capturedAt === undefined || typeof snapshot.capturedAt === 'number')
    )
  }

  protected isOptionalNullableString(value: unknown): boolean {
    return value === undefined || value === null || typeof value === 'string'
  }

  protected isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean'
  }

  protected snapshotKeychainCredentials(
    credentialsJson: string | null,
    previousSnapshot: ClaudeSystemDefaultSnapshot | null | undefined,
    service: 'scoped' | 'legacy',
    managedCredentialsJson: string | undefined
  ): string | null {
    if (managedCredentialsJson && credentialsJson === managedCredentialsJson && previousSnapshot) {
      const previousValue = this.readKeychainSnapshotValue(previousSnapshot, service)
      if (previousValue.status === 'captured') {
        return previousValue.credentialsJson
      }
    }
    return credentialsJson
  }

  protected hasValidKeychainSnapshotValue(
    snapshot: Record<string, unknown>,
    service: 'scoped' | 'legacy'
  ): boolean {
    const capturedKey =
      service === 'scoped'
        ? 'scopedKeychainCredentialsCaptured'
        : 'legacyKeychainCredentialsCaptured'
    if (snapshot[capturedKey] === false) {
      return true
    }
    const credentialsKey =
      service === 'scoped' ? 'scopedKeychainCredentialsJson' : 'legacyKeychainCredentialsJson'
    return (
      Object.hasOwn(snapshot, credentialsKey) || Object.hasOwn(snapshot, 'keychainCredentialsJson')
    )
  }

  protected readKeychainSnapshotValue(
    snapshot: ClaudeSystemDefaultSnapshot | null,
    service: 'scoped' | 'legacy'
  ): ClaudeKeychainSnapshotValue {
    if (!snapshot) {
      return { status: 'captured', credentialsJson: null }
    }
    const capturedKey =
      service === 'scoped'
        ? 'scopedKeychainCredentialsCaptured'
        : 'legacyKeychainCredentialsCaptured'
    if (snapshot[capturedKey] === false) {
      return { status: 'unknown' }
    }
    const credentialsKey =
      service === 'scoped' ? 'scopedKeychainCredentialsJson' : 'legacyKeychainCredentialsJson'
    if (Object.hasOwn(snapshot, credentialsKey)) {
      return {
        status: 'captured',
        credentialsJson: snapshot[credentialsKey] ?? null
      }
    }
    return { status: 'captured', credentialsJson: snapshot.keychainCredentialsJson }
  }

  protected async readAggregateClaudeKeychainCredentialsBestEffort(
    configDir: string
  ): Promise<string | null> {
    try {
      return await readActiveClaudeKeychainCredentials(configDir)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return null
    }
  }

  protected async readActiveClaudeKeychainCredentialsBestEffort(
    configDir?: string
  ): Promise<string | null> {
    try {
      return await readActiveClaudeKeychainCredentialsStrict(configDir)
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return null
    }
  }

  protected async readActiveClaudeKeychainCredentialsForSnapshot(
    configDir?: string
  ): Promise<ClaudeKeychainReadResult> {
    try {
      return {
        status: 'captured',
        credentialsJson: await readActiveClaudeKeychainCredentialsStrict(configDir)
      }
    } catch (error) {
      console.warn('[claude-runtime-auth] Failed to read Claude Keychain credentials:', error)
      return { status: 'failed' }
    }
  }
}
