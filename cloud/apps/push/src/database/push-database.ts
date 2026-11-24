import {
  openCloudDatabase,
  openInMemoryCloudDatabase,
  type CloudDatabase,
  type OpenCloudDatabaseInput
} from '@orca-cloud/cloud-database/cloud-database'
import { pushSchemaStatements } from './push-schema.js'

export async function openPushDatabase(
  input: Omit<OpenCloudDatabaseInput, 'service' | 'schemaStatements'>
): Promise<CloudDatabase> {
  return await openCloudDatabase({
    ...input,
    service: 'push',
    schemaStatements: pushSchemaStatements()
  })
}

export async function openInMemoryPushDatabase(): Promise<CloudDatabase> {
  return await openInMemoryCloudDatabase(pushSchemaStatements())
}
