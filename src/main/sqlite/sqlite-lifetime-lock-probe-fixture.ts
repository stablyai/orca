import { openSync, closeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import SyncDatabase from './sync-database'

const [path, mode] = process.argv.slice(2)
const database = new SyncDatabase(path, { timeout: 0 })
try {
  database.exec('BEGIN IMMEDIATE')
} catch (error) {
  database.close()
  if (error instanceof Error && /database is locked/.test(error.message)) {
    console.log(JSON.stringify({ state: 'busy' }))
    process.exit(0)
  }
  throw error
}
console.log(JSON.stringify({ state: 'acquired', transaction: database.isTransaction }))
if (mode === 'probe') {
  database.exec('ROLLBACK')
  database.close()
} else {
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    if (line === 'release') {
      database.exec('ROLLBACK')
      database.close()
      input.close()
      process.stdin.destroy()
    } else if (line === 'external-read') {
      // Exercise an unrelated same-process descriptor close, not a supported lock operation.
      closeSync(openSync(path, 'r'))
      console.log(JSON.stringify({ state: 'external-read', transaction: database.isTransaction }))
    }
  })
}
