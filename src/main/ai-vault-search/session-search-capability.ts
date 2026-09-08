import Database from '../sqlite/sync-database'

let cached: { available: boolean; reason?: string } | undefined

/** Probe FTS without opening a transcript index or discovering sources. */
export function sessionSearchCapability(): { available: boolean; reason?: string } {
  if (cached) {
    return cached
  }
  let database: Database | undefined
  try {
    database = new Database(':memory:')
    database.exec('CREATE VIRTUAL TABLE probe USING fts5(text)')
    cached = { available: true }
  } catch {
    cached = {
      available: false,
      reason: 'Session search requires Node.js with node:sqlite and FTS5 (Node 22.13 or newer).'
    }
  } finally {
    database?.close()
  }
  return cached
}
