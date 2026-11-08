// Applies the relay's own Postgres schema (unchanged DDL from cloud/apps/relay) to a local test
// database, so the edge runs the credential store against the same tables as production.
//   tsx test/apply-schema.ts postgres://relay@127.0.0.1:55433/relay
import pg from 'pg'
import { relayPostgresSchemaStatements } from '../../relay/src/database/database'

const url = process.argv[2]
if (!url) { throw new Error('usage: apply-schema.ts <postgres-url>') }
const client = new pg.Client({ connectionString: url })
await client.connect()
let applied = 0
for (const statement of relayPostgresSchemaStatements()) {
  try {
    await client.query(statement)
    applied++
  } catch (error) {
    // Migrations re-add objects the base schema already created; production skips them by catalog
    // pre-check, a fresh test database just ignores the duplicates.
    const code = String((error as { code?: unknown }).code)
    if (!['42710', '42P07', '42701', '42P16'].includes(code)) { throw error }
  }
}
await client.end()
console.log(`applied ${applied} statements`)
