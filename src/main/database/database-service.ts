import type {
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../shared/database-types'
import type { DatabaseProvider } from './database-provider'
import { DatabaseSshConnectionRoute } from './database-ssh-connection-route'
import { PostgresProvider } from './postgres-provider'

export class DatabaseService {
  private readonly providers: ReadonlyMap<DatabaseProviderId, DatabaseProvider>
  private readonly sshConnectionRoute: DatabaseSshConnectionRoute

  constructor(
    providers: readonly DatabaseProvider[] = [new PostgresProvider()],
    sshConnectionRoute = new DatabaseSshConnectionRoute()
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
    this.sshConnectionRoute = sshConnectionRoute
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
    return this.withProjectConnection(request, (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).testConnection(routedRequest, signal)
    )
  }

  async introspect(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseSchemaResult> {
    return this.withProjectConnection(request, (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).introspect(routedRequest, signal)
    )
  }

  async execute(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    return this.withProjectConnection(request, (routedRequest) =>
      this.getProvider(routedRequest.connection.providerId).execute(routedRequest, signal)
    )
  }

  async cancel(providerId: DatabaseProviderId, queryId: string): Promise<boolean> {
    return this.getProvider(providerId).cancel(queryId)
  }

  private async withProjectConnection<TRequest extends DatabaseConnectionRequest, TResult>(
    request: TRequest,
    operation: (request: TRequest) => Promise<TResult>
  ): Promise<TResult> {
    const routed = await this.sshConnectionRoute.open(request)
    try {
      return await operation({ ...request, connection: routed.connection })
    } finally {
      await routed.close()
    }
  }
}
