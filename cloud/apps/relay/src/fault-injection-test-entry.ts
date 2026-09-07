import { loadRelayConfig } from './config.js'
import { reconcileCellAdmissionAtStartup } from './cell-admission-startup.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { createRelayServer } from './relay-server.js'
import { readFileSync } from 'node:fs'

if (process.env.NODE_ENV !== 'test') {
  throw new Error('fault injection entry is test-only')
}

const pattern = process.env.ORCA_RELAY_TEST_FAULT_SQL
const clockFile = process.env.ORCA_RELAY_TEST_CLOCK_FILE
if (!pattern && !clockFile) throw new Error('a test fault configuration is required')

const config = loadRelayConfig()
const realDatabase = await openRelayDatabase({
  databaseUrl: config.databaseUrl,
  dataDir: config.dataDir
})
let faulted = false

function wrap(transaction: RelayDatabase): RelayDatabase {
  return {
    query: async (sql, params) => {
      if (pattern && !faulted && sql.includes(pattern)) {
        faulted = true
        throw new Error('injected SQL failure')
      }
      return await transaction.query(sql, params)
    },
    queryLocked: async (sql, params, options) =>
      await transaction.queryLocked(sql, params, options),
    transaction: async (operation) =>
      await transaction.transaction(async (nested) => await operation(wrap(nested))),
    close: async () => await transaction.close()
  }
}

const database = wrap(realDatabase)
const now = clockFile
  ? (): number => {
      const offset = Number(readFileSync(clockFile, 'utf8'))
      if (!Number.isFinite(offset)) throw new Error('invalid test clock offset')
      return Date.now() + offset
    }
  : Date.now
const { server, sessions, assignments } = createRelayServer(config, database, { now })
await reconcileCellAdmissionAtStartup(config, assignments)
server.listen(config.port, () => {
  console.log(`[orca-relay] listening on ${config.publicUrl} (port ${config.port})`)
})

const shutdown = (): void => {
  sessions.drain(0)
  server.close(() => void realDatabase.close())
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
