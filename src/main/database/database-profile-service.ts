import { randomUUID } from 'node:crypto'
import {
  toPersistedDatabaseConnection,
  type DatabaseConnectionConfig,
  type DatabaseConnectionRequest,
  type DatabaseExecutionContext,
  type DatabaseProfileSaveRequest,
  type DatabaseProfileSummary
} from '../../shared/database-types'
import type { DatabaseCredentialVault } from './database-credential-vault'
import type { DatabaseProfileRecord, DatabaseProfileStore } from './database-profile-store'

export type ResolvedDatabaseRequest<TRequest extends DatabaseConnectionRequest> = Omit<
  TRequest,
  'connection' | 'credential'
> &
  DatabaseConnectionRequest

export class DatabaseProfileService {
  private readonly store: DatabaseProfileStore
  private readonly vault: DatabaseCredentialVault

  constructor(store: DatabaseProfileStore, vault: DatabaseCredentialVault) {
    this.store = store
    this.vault = vault
  }

  list(execution?: DatabaseExecutionContext): DatabaseProfileSummary[] {
    return this.store.list(execution).map((profile) => this.withCredentialState(profile))
  }

  save(request: DatabaseProfileSaveRequest): DatabaseProfileSummary {
    if (request.credentialAction === 'save' && request.credential.password === undefined) {
      throw new Error('Enter a password before saving it')
    }
    const now = Date.now()
    const existing = request.profile.id
      ? this.store.get(request.profile.id, request.execution)
      : null
    if (request.profile.id && !existing) {
      throw new Error('Database profile was not found on this project node')
    }
    const connection = toPersistedDatabaseConnection(request.profile.connection)
    const endpointChanged = existing
      ? !credentialEndpointsMatch(existing.connection, connection)
      : false
    if (
      endpointChanged &&
      request.credentialAction === 'preserve' &&
      existing &&
      this.vault.has(existing.id)
    ) {
      throw new Error('Enter the password again after changing the database server')
    }
    if (endpointChanged && existing && request.credentialAction !== 'preserve') {
      // Why: remove the old endpoint-bound secret before publishing new endpoint
      // metadata. Any later write failure can lose a credential, but can never
      // forward the old server's password to the newly edited server.
      this.vault.delete(existing.id)
    }
    const record = this.store.save(
      {
        id: existing?.id ?? randomUUID(),
        name: request.profile.name.trim(),
        connection,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      },
      request.execution
    )
    if (request.credentialAction === 'save') {
      this.vault.set(record.id, request.credential.password as string)
    } else if (request.credentialAction === 'delete' && !endpointChanged) {
      this.vault.delete(record.id)
    }
    return this.withCredentialState(record)
  }

  delete(profileId: string, execution?: DatabaseExecutionContext): boolean {
    const deleted = this.store.delete(profileId, execution)
    if (deleted) {
      this.vault.delete(profileId)
    }
    return deleted
  }

  resolveRequest<TRequest extends DatabaseConnectionRequest>(
    request: TRequest
  ): ResolvedDatabaseRequest<TRequest> {
    if (!request.profileId) {
      return { ...request }
    }
    const profile = this.store.get(request.profileId, request.execution)
    if (!profile) {
      throw new Error('Database profile was not found on this project node')
    }
    if (!credentialEndpointsMatch(profile.connection, request.connection)) {
      throw new Error('Save the edited connection before using its stored password')
    }
    const password = request.credential.password ?? this.vault.get(profile.id) ?? undefined
    return {
      ...request,
      connection: request.connection,
      credential: { password }
    }
  }

  private withCredentialState(profile: DatabaseProfileRecord): DatabaseProfileSummary {
    return { ...profile, hasSavedPassword: this.vault.has(profile.id) }
  }
}

function credentialEndpointsMatch(
  profile: DatabaseConnectionConfig,
  requested: DatabaseConnectionConfig
): boolean {
  return !(
    profile.providerId !== requested.providerId ||
    profile.host !== requested.host ||
    profile.port !== requested.port ||
    profile.user !== requested.user ||
    profile.sslMode !== requested.sslMode
  )
}
