import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { OBJECT_STORE_SCHEMA } from '../src/object-store-schema.generated'
import { relayObjectStoreSchema } from './object-store-schema'

const FILE = new URL('../src/object-store-schema.generated.ts', import.meta.url)

it('object store schema matches the relay schema', async () => {
  const expected = await relayObjectStoreSchema()
  if (process.env.UPDATE_OBJECT_STORE_SCHEMA === '1') {
    const body = `// GENERATED from the relay's SQLite schema (sqlite_master) by test/object-store-schema.test.ts.\n// Do not edit; regenerate with UPDATE_OBJECT_STORE_SCHEMA=1.\nexport const OBJECT_STORE_SCHEMA: readonly string[] = ${JSON.stringify(expected, null, 2)}\n`
    if (readFileSync(FILE, 'utf8') !== body) writeFileSync(FILE, body)
    return
  }
  expect([...OBJECT_STORE_SCHEMA]).toEqual(expected)
})
