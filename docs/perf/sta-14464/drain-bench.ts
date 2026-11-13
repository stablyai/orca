// Times the real orphan drain after K session deletes (replacement K=1, retention K>1) on a scratch copy.
import { copyFileSync, rmSync } from 'node:fs'
import { SessionSearchStore } from '../../../src/main/ai-vault-search/storage/session-search-store'
import { drainOrphanedMessages } from '../../../src/main/ai-vault-search/storage/session-search-retention-delete'
const [src, ks = '0,1,20,100'] = process.argv.slice(2)
const out: Record<string, unknown> = {}
async function main(): Promise<void> {
  for (const k of ks.split(',').map(Number)) {
    const path = `${src}.drain.sqlite`
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
    copyFileSync(src, path)
    const store = new SessionSearchStore(path)
    const db = store.connection
    const ids = db
      .prepare('SELECT id FROM sessions ORDER BY id DESC LIMIT ?')
      .all(k)
      .map((r) => Number(r.id))
    db.exec('BEGIN')
    for (const id of ids) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    }
    db.exec('COMMIT')
    let drained = 0
    const t = performance.now()
    await drainOrphanedMessages(
      db,
      () => false,
      async () => undefined,
      (d) => {
        drained -= d
      }
    )
    out[`k${k}`] = { drain_ms: +(performance.now() - t).toFixed(1), drained }
    store.close()
    rmSync(path, { force: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
  }
  console.log(JSON.stringify(out))
}
void main()
