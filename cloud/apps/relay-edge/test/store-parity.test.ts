// P1: the relay's own credential-store tests, run against the Durable Object SQLite adapter
// instead of the relay's SQLite database. Any failure means the edge store would behave differently.
import { vi } from 'vitest'
import { openObjectDatabaseOnNodeSqlite } from './object-sqlite-fake'

vi.mock('../../relay/src/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../relay/src/database.js')>()),
  openInMemoryRelayDatabase: async () => openObjectDatabaseOnNodeSqlite()
}))

await import('../../relay/src/credential-store.test.ts')
await import('../../relay/src/credential-store-cleanup.test.ts')
