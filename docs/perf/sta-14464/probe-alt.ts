// Compares the current orphan probe with an index-seek probe on one DB (read-only unless --orphans).
import SyncDatabase from '../../../src/main/sqlite/sync-database'
const [path, orphans] = process.argv.slice(2)
const db = new SyncDatabase(path)
const OLD = `SELECT session_row_id FROM messages WHERE session_row_id NOT IN (SELECT id FROM sessions) LIMIT 1`
const SEEK = `WITH RECURSIVE ids(id) AS (
  SELECT (SELECT min(session_row_id) FROM messages)
  UNION ALL
  SELECT (SELECT min(session_row_id) FROM messages WHERE session_row_id > ids.id) FROM ids WHERE ids.id IS NOT NULL
) SELECT id AS session_row_id FROM ids
  WHERE id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = ids.id) LIMIT 1`
if (orphans) {
  for (const id of orphans.split(',')) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(Number(id))
  }
}
const run = (sql: string) => {
  const xs: number[] = []
  let r: unknown
  for (let i = 0; i < 7; i++) {
    const t = performance.now()
    r = db.prepare(sql).get()
    xs.push(performance.now() - t)
  }
  xs.sort((a, b) => a - b)
  return { median: +xs[3].toFixed(2), max: +xs[6].toFixed(2), result: r ?? null }
}
console.log(
  JSON.stringify({
    sessions: db.prepare('SELECT count(*) n FROM sessions').get(),
    old: run(OLD),
    seek: run(SEEK),
    seekPlan: db
      .prepare(`EXPLAIN QUERY PLAN ${SEEK}`)
      .all()
      .map((r) => r.detail)
  })
)
db.close()
