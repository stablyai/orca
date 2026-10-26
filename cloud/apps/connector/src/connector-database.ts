import {
  openCloudDatabase,
  openInMemoryCloudDatabase,
  type CloudDatabase,
  type OpenCloudDatabaseInput
} from '@orca-cloud/cloud-database'
import { connectorSchemaStatements } from './connector-schema.js'

export async function openConnectorDatabase(
  input: Omit<OpenCloudDatabaseInput, 'service' | 'schemaStatements'>
): Promise<CloudDatabase> {
  return await openCloudDatabase({
    ...input,
    service: 'connector',
    schemaStatements: connectorSchemaStatements()
  })
}

export async function openInMemoryConnectorDatabase(): Promise<CloudDatabase> {
  return await openInMemoryCloudDatabase(connectorSchemaStatements())
}
