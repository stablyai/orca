import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

const DISPATCH_IDENTITY_COLUMNS = [
  'retry_of_dispatch_id',
  'creator_dispatch_id',
  'host_scope'
] as const

describe('R1 identity migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('survives v30 to v31 to v30-writer to v31 without guessing provenance', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-r1-identity-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'legacy supervised worker' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { worktree: 'folder:/workspace' },
      runtimeEpoch: 'runtime-v30',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_old',
      paneKey: 'tab_old:leaf_old',
      processIncarnation: 'pty_old:incarnation-old',
      worktreeId: 'folder:/workspace',
      hostScope: JSON.stringify({ kind: 'ssh', targetId: 'box-old' }),
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    const resourceId = db.getWorkerTerminalResourceByOwner(started.dispatch.id)?.id
    db.close()
    db = undefined

    const v30 = new Database(dbPath)
    v30.exec(
      'DROP INDEX IF EXISTS idx_dispatch_retry_of; DROP INDEX IF EXISTS idx_dispatch_resource;'
    )
    for (const column of DISPATCH_IDENTITY_COLUMNS) {
      v30.exec(`ALTER TABLE dispatch_contexts DROP COLUMN ${column}`)
    }
    v30.exec('ALTER TABLE worker_terminal_resources DROP COLUMN endpoint_id')
    v30.exec('ALTER TABLE worker_terminal_resources DROP COLUMN endpoint_incarnation')
    v30.pragma('user_version = 30')
    v30.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
      retry_of_dispatch_id: null,
      creator_dispatch_id: null,
      host_scope: null
    })
    // Re-added by v31 without guessing: a v30 writer never recorded endpoint identity.
    expect(db.getWorkerTerminalResource(resourceId!)).toMatchObject({
      endpoint_id: null,
      endpoint_incarnation: null
    })
    db.close()
    db = undefined

    const oldWriter = new Database(dbPath)
    oldWriter.pragma('user_version = 30')
    oldWriter.exec(`
      INSERT INTO tasks (id, spec, status) VALUES ('task_old_writer', 'old writer', 'dispatched');
      INSERT INTO dispatch_contexts (id, task_id, status)
        VALUES ('ctx_old_writer', 'task_old_writer', 'dispatched');
    `)
    oldWriter.close()

    db = new OrchestrationDb(dbPath)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById('ctx_old_writer')).toMatchObject({
      creator_dispatch_id: null,
      host_scope: null
    })
  })

  it('drops the v31 identity columns no reader ever consumed', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-r1-identity-drop-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const v34 = new Database(dbPath)
    for (const column of ['creator_role', 'endpoint_id'] as const) {
      v34.exec(`ALTER TABLE dispatch_contexts ADD COLUMN ${column} TEXT`)
    }
    for (const column of ['endpoint_incarnation', 'attachment_kind', 'resource_id'] as const) {
      v34.exec(`ALTER TABLE dispatch_contexts ADD COLUMN ${column} TEXT`)
    }
    v34.exec('CREATE INDEX idx_dispatch_resource ON dispatch_contexts(resource_id)')
    v34.pragma('user_version = 34')
    v34.close()

    db = new OrchestrationDb(dbPath)
    const columns = (db.db.pragma('table_info(dispatch_contexts)') as { name: string }[]).map(
      ({ name }) => name
    )
    expect(columns).toEqual(
      expect.arrayContaining(['retry_of_dispatch_id', 'creator_dispatch_id', 'host_scope', 'depth'])
    )
    expect(columns).not.toContain('creator_role')
    expect(columns).not.toContain('resource_id')
    expect(columns).not.toContain('attachment_kind')
    expect(
      db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_dispatch_resource'").get()
    ).toBeUndefined()
  })
})
