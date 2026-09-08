import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import Database from '../../sqlite/sync-database'
import { journalDatabaseFile } from './journal-paths'
import { openAgentSessionJournal } from './journal-store-factory'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
const identity = {
  sessionId: 'crash-fixture',
  workspaceId: 'folder',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: { kind: 'codex' as const, threadId: 'disposable' }
}
const journalModule = './src/main/native-chat/agent-session-journal/journal-store-factory.ts'
const childScript = `
const ts = require('typescript-api');
const fs = require('node:fs');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const Database = require('./src/main/sqlite/sync-database.ts').default;
const stage = process.argv[2];
const exec = Database.prototype.exec;
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  const marker = {seal: 'INSERT INTO journal_recovery_epochs', prefix: 'INSERT INTO journal_rows',
    publish: 'INSERT INTO journal_sessions'}[stage];
  if (!marker || !sql.startsWith(marker)) return statement;
  return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (...args) => { target.run(...args); process.exit(73); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  }});
};
Database.prototype.exec = function(sql) {
  if (stage === 'before-commit' && sql === 'COMMIT') process.exit(73);
  exec.call(this, sql);
  if (stage === 'after-commit' && sql === 'COMMIT') process.exit(73);
};
require(${JSON.stringify(journalModule)}).openAgentSessionJournal({
  identity: ${JSON.stringify(identity)}, journalDir: process.argv[1]
}).then(() => process.exit(74)).catch(error => { console.error(error); process.exit(75); });
`

it.each(['seal', 'prefix', 'publish', 'before-commit', 'after-commit'])(
  'survives abrupt process exit after %s with original or complete generation',
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-repair-crash-'))
    roots.push(root)
    const journal = await openAgentSessionJournal({ identity, journalDir: root })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'prefix' },
      { kind: 'status', text: 'prefix' }
    )
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'fault' },
      { kind: 'status', text: 'fault' }
    )
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'suffix' },
      { kind: 'status', text: 'suffix' }
    )
    const epoch = journal.epoch
    await journal.close()
    const seeded = new Database(journalDatabaseFile(root))
    seeded.exec("UPDATE journal_rows SET row_json = '}{' WHERE seq = 3")
    const source = seeded
      .prepare('SELECT seq, hex(CAST(row_json AS BLOB)) AS bytes FROM journal_rows ORDER BY seq')
      .all()
    seeded.close()
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', childScript, root, stage],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000
    })
    expect(result, result.stderr).toMatchObject({ code: 73, timedOut: false })
    const db = new Database(journalDatabaseFile(root))
    try {
      expect(
        db
          .prepare(
            'SELECT seq, hex(CAST(row_json AS BLOB)) AS bytes FROM journal_rows WHERE epoch = ? ORDER BY seq'
          )
          .all(epoch)
      ).toEqual(source)
      const live = db.prepare('SELECT epoch FROM journal_sessions').get() as { epoch: string }
      const seals = db.prepare('SELECT count(*) AS n FROM journal_recovery_epochs').get()
      if (stage === 'after-commit') {
        expect(live.epoch).not.toBe(epoch)
        expect(seals).toMatchObject({ n: 1 })
        expect(
          db.prepare('SELECT seq FROM journal_rows WHERE epoch = ? ORDER BY seq').all(live.epoch)
        ).toEqual([{ seq: 1 }, { seq: 2 }])
        expect(db.prepare('SELECT epoch, content_from FROM journal_repairs').get()).toMatchObject({
          epoch: live.epoch,
          content_from: 3
        })
      } else {
        expect(live.epoch).toBe(epoch)
        expect(seals).toMatchObject({ n: 0 })
      }
    } finally {
      db.close()
    }
    const reopened = await openAgentSessionJournal({ identity, journalDir: root })
    expect(
      reopened
        .snapshot()
        .items.some((entry) => entry.body.kind === 'status' && entry.body.text === 'prefix')
    ).toBe(true)
    await reopened.close()
  }
)
