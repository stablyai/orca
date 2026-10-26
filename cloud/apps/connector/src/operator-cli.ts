import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { openConnectorDatabase } from './connector-database.js'

// An operator command against the service's database (its env), printing what it returns.
export async function runOperatorCli(
  applicationName: string,
  run: (database: CloudDatabase) => Promise<string>
): Promise<void> {
  const env = process.env
  const database = await openConnectorDatabase({
    ...(env.ORCA_CONNECTOR_DATABASE_URL ? { databaseUrl: env.ORCA_CONNECTOR_DATABASE_URL } : {}),
    dataDir: env.ORCA_CONNECTOR_DATA_DIR || './data/connector',
    poolMax: 1,
    applicationName
  })
  try {
    console.log(await run(database))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'failed')
    process.exitCode = 1
  } finally {
    await database.close()
  }
}
