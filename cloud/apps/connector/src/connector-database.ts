import {
  openCloudDatabase,
  openInMemoryCloudDatabase,
  type CloudDatabase,
  type OpenCloudDatabaseInput
} from '@orca-cloud/cloud-database'
import { connectorSchemaChanges } from './connector-schema-changes.js'
import { connectorSchemaStatements } from './connector-schema.js'
import { discordSchemaStatements } from './discord-schema.js'
import { slackSchemaStatements } from './slack-schema.js'

// Production has run these CREATE TABLEs, so editing one never reaches it. Change the schema by
// appending idempotent statements (ADD COLUMN IF NOT EXISTS, nullable or defaulted) to
// connector-schema-changes.ts; connector-schema-upgrade.test.ts boots the shipped baseline, then
// this list.
export const connectorBootStatements = () => [
  ...connectorSchemaStatements(),
  ...slackSchemaStatements(),
  ...discordSchemaStatements(),
  ...connectorSchemaChanges()
]

export async function openConnectorDatabase(
  input: Omit<OpenCloudDatabaseInput, 'service' | 'schemaStatements'>
): Promise<CloudDatabase> {
  return await openCloudDatabase({
    ...input,
    service: 'connector',
    schemaStatements: connectorBootStatements()
  })
}

export async function openInMemoryConnectorDatabase(): Promise<CloudDatabase> {
  return await openInMemoryCloudDatabase(connectorBootStatements())
}
