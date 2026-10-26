import {
  openCloudDatabase,
  openInMemoryCloudDatabase,
  type CloudDatabase,
  type OpenCloudDatabaseInput
} from '@orca-cloud/cloud-database'
import { connectorSchemaStatements } from './connector-schema.js'
import { slackSchemaStatements } from './slack-schema.js'

const schemaStatements = () => [...connectorSchemaStatements(), ...slackSchemaStatements()]

export async function openConnectorDatabase(
  input: Omit<OpenCloudDatabaseInput, 'service' | 'schemaStatements'>
): Promise<CloudDatabase> {
  return await openCloudDatabase({
    ...input,
    service: 'connector',
    schemaStatements: schemaStatements()
  })
}

export async function openInMemoryConnectorDatabase(): Promise<CloudDatabase> {
  return await openInMemoryCloudDatabase(schemaStatements())
}
