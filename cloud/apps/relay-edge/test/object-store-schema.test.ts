import { expect, it } from 'vitest'
import { OBJECT_STORE_SCHEMA } from '../src/object-store-schema.generated'

it('stamps fresh objects, keeps pre-version ones, refuses objects newer than the code', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { nodeObjectSql } = await import('./object-sqlite-fake')
  const { openSchema, OBJECT_SCHEMA_VERSION } = await import('../src/object-store')
  const version = (sql: ReturnType<typeof nodeObjectSql>) => sql.exec('SELECT schema_version AS v FROM edge_meta').toArray()[0]?.v
  const fresh = nodeObjectSql()
  openSchema(fresh)
  openSchema(fresh)
  expect(version(fresh)).toBe(OBJECT_SCHEMA_VERSION)
  expect(fresh.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'edge_assignment'").toArray()[0]?.n).toBe(1)
  // An object from before versioning: its rows survive.
  const legacy = nodeObjectSql(new DatabaseSync(':memory:'))
  for (const statement of OBJECT_STORE_SCHEMA) { legacy.exec(statement) }
  legacy.exec("CREATE TABLE edge_assignment (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, relay_host_id TEXT NOT NULL, cell_id TEXT NOT NULL, assignment_epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.exec("INSERT INTO edge_assignment VALUES (1, 'u', 'h', 'edge', 3, 1)")
  openSchema(legacy)
  expect(version(legacy)).toBe(OBJECT_SCHEMA_VERSION)
  expect(legacy.exec('SELECT assignment_epoch AS e FROM edge_assignment').toArray()[0]?.e).toBe(3)
  // Written by newer code, then the deploy rolled back.
  fresh.exec('UPDATE edge_meta SET schema_version = ?', OBJECT_SCHEMA_VERSION + 1)
  expect(() => openSchema(fresh)).toThrow('edge_object_schema_newer')
})
