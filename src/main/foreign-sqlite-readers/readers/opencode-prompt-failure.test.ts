import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readOpenCodePromptFailure } from './opencode-prompt-failure'

let directory: string
let db: SyncDatabase
let dbPath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-opencode-failure-'))
  dbPath = join(directory, 'opencode.db')
  db = new SyncDatabase(dbPath)
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT
  ); CREATE INDEX session_message_session_seq ON session_message(session_id, seq);`)
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
    'input',
    'ses-own',
    'user',
    0,
    100,
    '{}'
  )
})

afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function message(seq: number, error: unknown, options: { session?: string; at?: number } = {}) {
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
    `msg-${seq}`,
    options.session ?? 'ses-own',
    'idle',
    seq,
    options.at ?? 150,
    JSON.stringify({ error })
  )
}

const quota = { type: 'provider.quota', message: 'Free usage limit reached.', status: 429 }
const query = { sessionId: 'ses-own', startedAt: 100, failedAt: 200 }

describe('OpenCode native prompt failure', () => {
  it('recovers the native type and HTTP status from the completed turn', () => {
    message(1, quota)
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({
      failure: { ...quota, inputId: 'input' }
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_message').get()).toEqual({ count: 2 })
  })

  it('does not reuse an outcome when a newer input arrives in the same millisecond', () => {
    message(1, quota, { at: 100 })
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'next-input',
      'ses-own',
      'user',
      2,
      100,
      '{}'
    )
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
  })

  it('requires an input from this prompt even when an older execution fails during its window', () => {
    db.prepare('UPDATE session_message SET time_created = 99 WHERE id = ?').run('input')
    message(1, quota)
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
  })

  it('ignores other sessions and failures before or after this prompt', () => {
    message(1, quota, { at: 99 })
    message(2, quota, { at: 201 })
    message(3, quota, { session: 'ses-other' })
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
  })

  it('does not reuse a failed step after a newer successful outcome', () => {
    message(1, quota)
    message(2, undefined)
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
  })

  it('keeps retry timing anchored to the native failure rather than the eventual read', () => {
    message(1, {
      type: 'provider.rate-limit',
      message: 'Slow down',
      status: 429,
      retryAfterMs: 60_000
    })
    expect(readOpenCodePromptFailure({ dbPath, ...query }).failure).toMatchObject({
      resetsAt: 60_150
    })
  })

  it.each([-1, 'invalid', 1e99])(
    'ignores malformed retry timing without losing the failure: %j',
    (retryAfterMs) => {
      message(1, { ...quota, retryAfterMs })
      expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({
        failure: { ...quota, inputId: 'input' }
      })
    }
  )

  it('preserves a typed gateway refusal hidden behind native authentication classification', () => {
    message(1, {
      type: 'provider.auth',
      message: 'Provider authentication required',
      status: 403,
      response: {
        body: JSON.stringify({ error: { type: 'RegionError', message: 'Region blocked' } })
      }
    })
    expect(readOpenCodePromptFailure({ dbPath, ...query }).failure).toMatchObject({
      status: 403,
      responseType: 'RegionError',
      responseMessage: 'Region blocked'
    })
  })

  it('bounds provider response bodies without losing the native failure', () => {
    message(1, { ...quota, response: { body: 'x'.repeat(100_000) } })
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({
      failure: { ...quota, inputId: 'input' }
    })
  })

  it('leaves unknown schemas and malformed latest messages unresolved', () => {
    message(1, quota)
    db.prepare('UPDATE session_message SET data = ?').run('{broken')
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
    db.exec('DROP TABLE session_message')
    expect(readOpenCodePromptFailure({ dbPath, ...query })).toEqual({ failure: null })
  })
})
