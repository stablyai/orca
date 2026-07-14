import type {
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseProviderId,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../shared/database-types'

export type DatabaseProvider = {
  readonly id: DatabaseProviderId
  testConnection(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseConnectionTestResult>
  introspect(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseSchemaResult>
  execute(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult>
  cancel(queryId: string): Promise<boolean>
}
