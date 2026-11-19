import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { compactOrchestrationDb } from './orchestration-db-compaction'

const dirs: string[] = []
const holders: ReturnType<typeof spawn>[] = []

/** A real orchestration database as an older build left it: no auto-vacuum, `freedMiB` of free pages. */
function legacyDatabase(
  options: { keptMiB?: number; freedMiB?: number; activeWorker?: boolean } = {}
): string {
  const { keptMiB = 8, freedMiB = 40, activeWorker = false } = options
  const dir = mkdtempSync(join(tmpdir(), 'orca-orchestration-compaction-'))
  dirs.push(dir)
  const file = join(dir, 'orchestration.db')
  const orchestration = new OrchestrationDb(file)
  if (activeWorker) {
    const task = orchestration.createTask({ runId: 'run_legacy_local', spec: 'still working' })
    orchestration.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
  }
  orchestration.close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA auto_vacuum = NONE; VACUUM; CREATE TABLE qa_filler (body BLOB)')
  const insert = db.prepare('INSERT INTO qa_filler (body) VALUES (randomblob(1048576))')
  db.exec('BEGIN')
  for (let i = 0; i < keptMiB + freedMiB; i++) {
    insert.run()
  }
  db.exec('COMMIT')
  db.prepare('DELETE FROM qa_filler WHERE rowid > ?').run(keptMiB)
  db.close()
  return file
}

function inspect(file: string): { autoVacuum: number; integrity: string } {
  const db = new DatabaseSync(file)
  try {
    return {
      autoVacuum: Number(db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum),
      integrity: String(db.prepare('PRAGMA integrity_check').get()!.integrity_check)
    }
  } finally {
    db.close()
  }
}

/** Another process with the file open and idle, as the terminal daemon or a second Orca would hold it. */
async function holdOpenInAnotherProcess(file: string): Promise<void> {
  const holder = spawn(
    process.execPath,
    [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.prepare('SELECT count(*) FROM runs').get();
       process.stdout.write('ready\\n');
       setInterval(() => {}, 1000);`,
      file
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  holders.push(holder)
  await once(holder.stdout!, 'data')
}

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill('SIGKILL')
    await once(holder, 'exit')
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('compactOrchestrationDb', () => {
  it('shrinks a mostly free legacy file once and switches it to incremental', async () => {
    const file = legacyDatabase()
    const before = statSync(file).size

    expect((await compactOrchestrationDb(file)).kind).toBe('compacted')

    expect(statSync(file).size).toBeLessThan(before / 4)
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok' })
    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'not-needed' })
  })

  it('leaves the file alone while a worker is still running', async () => {
    const file = legacyDatabase({ activeWorker: true })

    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'active' })
    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok' })
  })

  it('leaves the file alone while another process holds it open', async () => {
    const file = legacyDatabase()
    await holdOpenInAnotherProcess(file)

    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'busy' })
    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok' })
  })

  it('waits out both a running worker and the daemon holding the file', async () => {
    const file = legacyDatabase({ activeWorker: true })
    await holdOpenInAnotherProcess(file)

    // The runtime sees the worker first; without it, the daemon's connection still refuses the lock.
    expect(await compactOrchestrationDb(file, { isActive: () => true })).toEqual({ kind: 'active' })
    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'busy' })
    const holder = holders.pop()!
    holder.kill('SIGKILL')
    await once(holder, 'exit')
    // That attempt counted as the file's one try.
    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'deferred', timeouts: 1 })
    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok' })
  })

  it('stops when the checks used up its budget and leaves the file as it was', async () => {
    const file = legacyDatabase()

    expect((await compactOrchestrationDb(file, { budgetMs: 0 })).kind).toBe('timed-out')
    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok' })
  })

  it('stops trying after one stopped attempt until the live data shrinks', async () => {
    const file = legacyDatabase()
    await compactOrchestrationDb(file, { budgetMs: 0 })

    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'deferred', timeouts: 1 })
    expect(inspect(file).autoVacuum).toBe(0)
  })

  it('compacts once the caller hands over its own open connection', async () => {
    const file = legacyDatabase()
    const own = new DatabaseSync(file)
    own.prepare('SELECT count(*) FROM runs').get()

    const result = await compactOrchestrationDb(file, { release: () => own.close() })

    expect(result.kind).toBe('compacted')
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok' })
  })

  it('skips a file with under 32 MiB free', async () => {
    const file = legacyDatabase({ keptMiB: 1, freedMiB: 20 })

    expect(await compactOrchestrationDb(file)).toEqual({ kind: 'not-needed' })
    expect(inspect(file).autoVacuum).toBe(0)
  })
})
