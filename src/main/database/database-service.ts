import type {
  DatabaseCatalogResult,
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseExecutionContext,
  DatabaseProfileSaveRequest,
  DatabaseProfileSummary,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../shared/database-types'
import type { DatabaseProvider } from './database-provider'
import type { DatabaseProfileService, ResolvedDatabaseRequest } from './database-profile-service'
import { DatabaseSshConnectionRoute } from './database-ssh-connection-route'
import { PostgresProvider } from './postgres-provider'

export class DatabaseService {
  private readonly providers: ReadonlyMap<DatabaseProviderId, DatabaseProvider>
  private readonly sshConnectionRoute: DatabaseSshConnectionRoute
  private readonly profileService: DatabaseProfileService | null

  constructor(
    providers: readonly DatabaseProvider[] = [new PostgresProvider()],
    sshConnectionRoute = new DatabaseSshConnectionRoute(),
    profileService: DatabaseProfileService | null = null
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.sshConnectionRoute = sshConnectionRoute
    this.profileService = profileService
  }

  private getProvider(providerId: DatabaseProviderId): DatabaseProvider {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Unsupported database provider: ${providerId}`)
    }
    return provider
  }

  async testConnection(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseConnectionTestResult> {
    return this.withProjectConnection(this.resolveRequest(request), (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).testConnection(routedRequest, signal)
    )
  }

  async introspect(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseSchemaResult> {
    return this.withProjectConnection(this.resolveRequest(request), (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).introspect(routedRequest, signal)
    )
  }

  async catalog(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseCatalogResult> {
    return this.withProjectConnection(this.resolveRequest(request), (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).catalog(routedRequest, signal)
    )
  }

  async execute(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    return this.withProjectConnection(this.resolveRequest(request), (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).execute(routedRequest, signal)
    )
  }

  async cancel(providerId: DatabaseProviderId, queryId: string): Promise<boolean> {
    return this.getProvider(providerId).cancel(queryId)
  }

  listProfiles(execution?: DatabaseExecutionContext): DatabaseProfileSummary[] {
    return this.getProfileService().list(execution)
  }

  saveProfile(request: DatabaseProfileSaveRequest): DatabaseProfileSummary {
    return this.getProfileService().save(request)
  }

  deleteProfile(profileId: string, execution?: DatabaseExecutionContext): boolean {
    return this.getProfileService().delete(profileId, execution)
  }

  private resolveRequest<TRequest extends DatabaseConnectionRequest>(
    request: TRequest
  ): ResolvedDatabaseRequest<TRequest> {
    return this.profileService?.resolveRequest(request) ?? request
  }

  private getProfileService(): DatabaseProfileService {
    if (!this.profileService) {
      throw new Error('Database profiles are unavailable in this runtime')
    }
    return this.profileService
  }

  private async withProjectConnection<TRequest extends DatabaseConnectionRequest, TResult>(
    request: TRequest,
    operation: (request: TRequest) => Promise<TResult>
  ): Promise<TResult> {
    const routed = await this.sshConnectionRoute.open(request)
    try {
      return await operation({ ...request, connection: routed.connection })
    } finally {
      try {
        await routed.close()
      } catch (error) {
        // Why: tunnel cleanup is best-effort after the operation has settled;
        // replacing its result/error would make a successful query look failed.
        console.error('[database] Failed to close the project SSH tunnel', error)
      }
    }
  }
}
