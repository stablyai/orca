import { readFileSync, writeFileSync } from 'node:fs'
import { relayObjectStoreSchema } from './object-store-schema'

const FILE = new URL('../src/object-store-schema.generated.ts', import.meta.url)

if (process.env.UPDATE_OBJECT_STORE_SCHEMA === '1') {
  const expected = await relayObjectStoreSchema()
  const body = `// GENERATED from the relay's SQLite schema (sqlite_master) by test/generate-object-store-schema.ts.\n// Do not edit; regenerate with UPDATE_OBJECT_STORE_SCHEMA=1 ./node_modules/.bin/tsx test/generate-object-store-schema.ts.\nexport const OBJECT_STORE_SCHEMA: readonly string[] = ${JSON.stringify(expected, null, 2)}\n`
  if (readFileSync(FILE, 'utf8') !== body) { writeFileSync(FILE, body) }
}
