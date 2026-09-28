import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'

assert.equal(process.versions.bun, ORCAD_BUN_VERSION)

// Exercise JIT, crypto, compression and SQLite under the emulated CPU feature set.
const values = Array.from({ length: 100_000 }, (_, index) => index % 997)
let total = 0
for (let iteration = 0; iteration < 100; iteration++) {
  total = values.reduce((sum, value) => sum + value, 0)
}
assert.equal(total, 49_695_450)
const payload = Buffer.from(JSON.stringify(values))
assert.deepEqual(inflateSync(deflateSync(payload)), payload)
const digest = createHash('sha256').update(payload).digest('hex')
const database = new Database(':memory:')
try {
  database.exec('CREATE TABLE sample (digest TEXT, total INTEGER)')
  database.transaction(() => {
    database.query('INSERT INTO sample VALUES (?, ?)').run(digest, total)
  })()
  assert.deepEqual(database.query('SELECT * FROM sample').get(), { digest, total })
} finally {
  database.close()
}
console.log(`Bun ${process.versions.bun} CPU baseline smoke passed`)
