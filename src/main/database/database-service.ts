import type {
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../shared/database-types'
import type { DatabaseProvider } from './database-provider'
import { PostgresProvider } from './postgres-provider'

export class DatabaseService {
  private readonly providers: ReadonlyMap<DatabaseProviderId, DatabaseProvider>

  constructor(providers: readonly DatabaseProvider[] = [new PostgresProvider()]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  private getProvider(providerId: DatabaseProviderId): DatabaseProvider {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Unsupported database provider: ${providerId}`)
    }
    return provider
  }

  testConnection(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseConnectionTestResult> {
    return this.getProvider(request.connection.providerId).testConnection(request, signal)
  }

  introspect(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseSchemaResult> {
    return this.getProvider(request.connection.providerId).introspect(request, signal)
  }

  execute(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    return this.getProvider(request.connection.providerId).execute(request, signal)
  }

  async cancel(providerId: DatabaseProviderId, queryId: string): Promise<boolean> {
    return this.getProvider(providerId).cancel(queryId)
  }
}
