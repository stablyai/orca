import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  messageField as mField,
  stringField as sField,
  varintField as vField
} from './protobuf-test-encoder'
import { parseAntigravitySqliteSession } from './session-scanner-antigravity-sqlite'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

// #5 metadata carries the created Timestamp at #5.#1 = { #1 seconds, #2 nanos }.
const metaWithTimestamp = (seconds: number): number[] =>
  mField(5, mField(1, [...vField(1, seconds), ...vField(2, 0)]))

const userStep = (text: string, seconds: number): Uint8Array =>
  new Uint8Array([
    ...vField(1, 14),
    ...vField(4, 3),
    ...metaWithTimestamp(seconds),
    ...mField(19, sField(2, text))
  ])
const assistantStep = (text: string, seconds: number): Uint8Array =>
  new Uint8Array([
    ...vField(1, 15),
    ...vField(4, 3),
    ...metaWithTimestamp(seconds),
    ...mField(20, sField(3, text))
  ])
// A type-15 step that only invokes a tool (no #20.#3 assistant text).
const assistantToolStep = (seconds: number): Uint8Array =>
  new Uint8Array([
    ...vField(1, 15),
    ...vField(4, 3),
    ...metaWithTimestamp(seconds),
    ...mField(20, mField(7, sField(2, 'run_command')))
  ])
const metadataBlob = (workspaceUri: string): Uint8Array =>
  new Uint8Array(mField(3, sField(12, workspaceUri)))

// ---- Fixture DB helpers ----
function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-antigravity-'))
  tempDirs.push(dir)
  const path = join(dir, 'conversation.db')
  return { db: new Database(path), path }
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE steps (
      idx integer,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 0,
      has_subtrajectory numeric NOT NULL DEFAULT 0,
      metadata blob, error_details blob, permissions blob, task_details blob,
      render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0,
      PRIMARY KEY (idx)
    );
    CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));
  `)
}

function insertStep(
  db: Database.Database,
  idx: number,
  stepType: number,
  payload: Uint8Array
): void {
  db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
    idx,
    stepType,
    payload
  )
}

function insertMetadataBlob(db: Database.Database, data: Uint8Array): void {
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', data)
}

describe('parseAntigravitySqliteSession', () => {
  it('reconstructs title, previews, cwd, counts, and resume command', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    const workspaceUri = `file:///Users/macbook/Desktop/${encodeURIComponent('리뷰캐스트')}`
    insertMetadataBlob(db, metadataBlob(workspaceUri))
    insertStep(db, 0, 14, userStep('클로드랑 대화해서 점수향상좀', 1783694042))
    insertStep(db, 1, 15, assistantStep('**Analyzing** the request', 1783694050))
    insertStep(db, 2, 15, assistantToolStep(1783694060)) // tool-only: no assistant text
    insertStep(db, 3, 14, userStep('0.8581 나왔어', 1783694100))
    db.close()

    const session = await parseAntigravitySqliteSession({
      dbPath: path,
      sessionId: 'conv-uuid-1234',
      platform: 'darwin'
    })

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('antigravity')
    expect(session?.sessionId).toBe('conv-uuid-1234')
    expect(session?.title).toBe('클로드랑 대화해서 점수향상좀')
    expect(session?.cwd).toBe('/Users/macbook/Desktop/리뷰캐스트')
    // 2 user turns + 1 assistant text turn; the tool-only step is not a message.
    expect(session?.messageCount).toBe(3)
    expect(session?.previewMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(session?.previewMessages[0]?.text).toBe('클로드랑 대화해서 점수향상좀')
    expect(session?.resumeCommand).toContain("agy --conversation 'conv-uuid-1234'")
    expect(session?.createdAt).toBe(new Date(1783694042 * 1000).toISOString())
    expect(session?.updatedAt).toBe(new Date(1783694100 * 1000).toISOString())
  })

  it('returns null when the steps table is absent', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE unrelated (x integer)')
    db.close()

    const session = await parseAntigravitySqliteSession({
      dbPath: path,
      sessionId: 'x',
      platform: 'darwin'
    })
    expect(session).toBeNull()
  })

  it('falls back to the workspace basename as title when there are no user turns', async () => {
    const { db, path } = createTempDb()
    applySchema(db)
    insertMetadataBlob(db, metadataBlob('file:///Users/macbook/Desktop/samsung-scpc'))
    insertStep(db, 0, 15, assistantStep('bootstrapping', 1783694042))
    db.close()

    const session = await parseAntigravitySqliteSession({
      dbPath: path,
      sessionId: 'y',
      platform: 'darwin'
    })
    expect(session?.title).toBe('samsung-scpc')
  })
})
