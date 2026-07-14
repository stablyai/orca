import type { Client } from 'pg'
import type { DatabaseCatalogResult } from '../../shared/database-types'

const MAX_CATALOG_DATABASES = 1_000
const MAX_CATALOG_SCHEMAS = 5_000

export async function loadPostgresCatalog(
  client: Client,
  fallbackDatabase: string
): Promise<DatabaseCatalogResult> {
  const [databases, schemas, current] = await Promise.all([
    client.query<{ datname: string }>(
      `SELECT datname
         FROM pg_database
        WHERE datallowconn
          AND NOT datistemplate
          AND has_database_privilege(datname, 'CONNECT')
        ORDER BY datname
        LIMIT ${MAX_CATALOG_DATABASES}`
    ),
    client.query<{ schema_name: string }>(
      `SELECT schema_name
         FROM information_schema.schemata
        WHERE schema_name <> 'information_schema'
          AND schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
          AND has_schema_privilege(schema_name, 'USAGE')
        ORDER BY schema_name
        LIMIT ${MAX_CATALOG_SCHEMAS}`
    ),
    client.query<{ database: string; schema: string | null }>(
      'SELECT current_database() AS database, current_schema() AS schema'
    )
  ])
  return {
    databases: databases.rows.map((row) => row.datname),
    schemas: schemas.rows.map((row) => row.schema_name),
    currentDatabase: current.rows[0]?.database ?? fallbackDatabase,
    currentSchema: current.rows[0]?.schema ?? null
  }
}
