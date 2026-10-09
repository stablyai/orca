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
      this.isOptionalBoolean(snapshot.scopedKeychainCredentialsEmpty) &&
      this.isOptionalBoolean(snapshot.legacyKeychainCredentialsEmpty) &&
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
  ): ClaudeKeychainSnapshotValue {
    if (this.isEmptyClaudeOAuthCredentials(credentialsJson)) {
      return { status: 'empty' }
    }
    if (
      managedCredentialsJson &&
      this.accountCredentialFieldsEqual(credentialsJson, managedCredentialsJson) &&
      previousSnapshot
    ) {
      const previousValue = this.readKeychainSnapshotValue(previousSnapshot, service)
      return previousValue
    }
    return { status: 'captured', credentialsJson }
  }

  protected hasValidKeychainSnapshotValue(
    snapshot: Record<string, unknown>,
    service: 'scoped' | 'legacy'
  ): boolean {
    const capturedKey =
      service === 'scoped'
        ? 'scopedKeychainCredentialsCaptured'
        : 'legacyKeychainCredentialsCaptured'
    const emptyKey =
      service === 'scoped' ? 'scopedKeychainCredentialsEmpty' : 'legacyKeychainCredentialsEmpty'
    if (snapshot[emptyKey] === true) {
      return snapshot[capturedKey] !== true
    }
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
    const emptyKey =
      service === 'scoped' ? 'scopedKeychainCredentialsEmpty' : 'legacyKeychainCredentialsEmpty'
    if (snapshot[emptyKey] === true) {
      return { status: 'empty' }
    }
    if (snapshot[capturedKey] === false) {
      return { status: 'unknown' }
    }
    const credentialsKey =
      service === 'scoped' ? 'scopedKeychainCredentialsJson' : 'legacyKeychainCredentialsJson'
    const credentialsJson = Object.hasOwn(snapshot, credentialsKey)
      ? (snapshot[credentialsKey] ?? null)
      : snapshot.keychainCredentialsJson
    if (this.isEmptyClaudeOAuthCredentials(credentialsJson)) {
      return { status: 'empty' }
    }
    if (Object.hasOwn(snapshot, credentialsKey)) {
      return {
        status: 'captured',
        credentialsJson: credentialsJson ?? null
      }
    }
    return { status: 'captured', credentialsJson: credentialsJson ?? null }
  }

  protected hasEmptyClaudeKeychainSnapshot(snapshot: ClaudeSystemDefaultSnapshot | null): boolean {
    return (
      this.readKeychainSnapshotValue(snapshot, 'scoped').status === 'empty' ||
      this.readKeychainSnapshotValue(snapshot, 'legacy').status === 'empty'
    )
  }

  protected isEmptyClaudeOAuthCredentials(credentialsJson: string | null | undefined): boolean {
    if (typeof credentialsJson !== 'string') {
      return false
    }
    try {
      const credentials = this.asRecord(JSON.parse(credentialsJson))
      const oauth = this.asRecord(credentials?.claudeAiOauth)
      return (
        oauth !== null &&
        this.normalizeField(this.readString(oauth, 'accessToken')) === null &&
        this.normalizeField(this.readString(oauth, 'refreshToken')) === null
      )
    } catch {
      return false
    }
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
