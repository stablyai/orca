import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  applyMinimalOpenCodeSqliteSchema,
  applyOpenCodeSqliteSchema,
  insertOpenCodeMessage,
  insertOpenCodePart,
  insertOpenCodeSession
} from './session-scanner-opencode-sqlite-fixtures'
import { buildOpenCodeSqliteCandidatePath } from './session-scanner-opencode-sqlite-paths'
import { listOpenCodeSqliteSessions } from './session-scanner-opencode-sqlite-discovery'
import { parseOpenCodeSqliteSession } from './session-scanner-opencode-sqlite'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-sqlite-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

describe('listOpenCodeSqliteSessions', () => {
  it('returns candidates sorted by time_updated desc via the synthesized mtimeMs', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_old',
      title: 'Old',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertOpenCodeSession(db, {
      id: 'ses_new',
      title: 'New',
      timeCreated: 1_777_634_002_000,
      timeUpdated: 1_777_634_003_000
    })
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(2)
    expect(candidates[0].agent).toBe('opencode')
    expect(candidates[0].file.mtimeMs).toBe(1_777_634_003_000)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_new'))
    expect(candidates[1].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_old'))
  })

  it('dedups matching session ids across databases and keeps the newest row', async () => {
    const { db: oldDb, path: oldPath } = createTempDb()
    applyOpenCodeSqliteSchema(oldDb)
    insertOpenCodeSession(oldDb, {
      id: 'ses_duplicate',
      title: 'Old duplicate',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    oldDb.close()

    const { db: newDb, path: newPath } = createTempDb()
    applyOpenCodeSqliteSchema(newDb)
    insertOpenCodeSession(newDb, {
      id: 'ses_duplicate',
      title: 'New duplicate',
      timeCreated: 1_777_634_002_000,
      timeUpdated: 1_777_634_003_000
    })
    newDb.close()

    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [oldPath, newPath],
      limit: 10,
      issues: []
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(newPath, 'ses_duplicate'))
  })
  it('excludes archived and child sessions', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_normal',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertOpenCodeSession(db, {
      id: 'ses_archived',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_002_000,
      timeArchived: 1_777_634_002_500
    })
    insertOpenCodeSession(db, {
      id: 'ses_child',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_003_000,
      parentId: 'ses_normal'
    })
    db.close()

    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: []
    })
    expect(candidates.map((c) => c.file.path)).toEqual([
      buildOpenCodeSqliteCandidatePath(path, 'ses_normal')
    ])
  })

  it('returns [] when the session table is missing (legacy install)', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE other (id TEXT)')
    db.close()
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues: []
    })
    expect(candidates).toEqual([])
  })

  it('records an issue when the DB file does not exist', async () => {
    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: ['/nonexistent/opencode.db'],
      limit: 10,
      issues
    })
    expect(candidates).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0].agent).toBe('opencode')
    expect(issues[0].path).toBe('/nonexistent/opencode.db')
  })

  it('lists sessions from a minimal readable session table', async () => {
    const { db, path } = createTempDb()
    applyMinimalOpenCodeSqliteSchema(db)
    db.prepare(`INSERT INTO session VALUES ('ses_minimal', 1777634000000, 1777634001000)`).run()
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listOpenCodeSqliteSessions({
      dbPaths: [path],
      limit: 10,
      issues
    })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.path).toBe(buildOpenCodeSqliteCandidatePath(path, 'ses_minimal'))
  })
})

describe('parseOpenCodeSqliteSession', () => {
  it('builds an AiVaultSession with title, cwd, model, tokens, and resume command', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_1',
      title: 'OpenCode title',
      directory: '/tmp/opencode',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000,
      tokensInput: 100,
      tokensOutput: 40,
      tokensReasoning: 10,
      tokensCacheRead: 5,
      cost: 0.01
    })
    insertOpenCodeMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_1',
      role: 'user',
      timeCreated: 1_777_634_000_500,
      summaryTitle: 'OpenCode title'
    })
    insertOpenCodePart(db, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 1_777_634_000_500,
      text: 'Plan the work'
    })
    insertOpenCodeMessage(db, {
      id: 'msg_2',
      sessionId: 'ses_1',
      role: 'assistant',
      timeCreated: 1_777_634_000_900
    })
    insertOpenCodePart(db, {
      id: 'prt_2',
      messageId: 'msg_2',
      sessionId: 'ses_1',
      timeCreated: 1_777_634_001_000,
      text: 'Done'
    })
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_1',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.agent).toBe('opencode')
    expect(session!.sessionId).toBe('ses_1')
    expect(session!.filePath).toBe(path)
    expect(session!.title).toBe('OpenCode title')
    expect(session!.cwd).toBe('/tmp/opencode')
    expect(session!.model).toBe('glm-5.2')
    expect(session!.totalTokens).toBe(150)
    expect(session!.messageCount).toBe(2)
    expect(session!.createdAt).toBe(new Date(1_777_634_000_000).toISOString())
    expect(session!.updatedAt).toBe(new Date(1_777_634_001_000).toISOString())
    expect(session!.resumeCommand).toBe("cd '/tmp/opencode' && opencode --session 'ses_1'")
    expect(session!.previewMessages).toHaveLength(2)
    expect(session!.previewMessages[0].text).toBe('Plan the work')
    expect(session!.previewMessages[0].role).toBe('user')
    expect(session!.previewMessages[1].text).toBe('Done')
    expect(session!.previewMessages[1].role).toBe('assistant')
  })

  it('falls back to summary.body for title when session.title is empty', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_2',
      title: '',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    insertOpenCodeMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_2',
      role: 'user',
      timeCreated: 1_777_634_000_500,
      summaryBody: 'fallback title from summary'
    })
    insertOpenCodePart(db, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_2',
      timeCreated: 1_777_634_000_500,
      text: 'hello'
    })
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_2',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.title).toBe('fallback title from summary')
  })

  it('returns null when the session id is not found', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_real',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000
    })
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_missing',
      platform: 'darwin'
    })
    expect(session).toBeNull()
  })

  it('returns null when the DB has no session table', async () => {
    const { db, path } = createTempDb()
    db.exec('CREATE TABLE other (id TEXT)')
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_1',
      platform: 'darwin'
    })
    expect(session).toBeNull()
  })

  it('parses a minimal readable session table without optional columns or messages', async () => {
    const { db, path } = createTempDb()
    applyMinimalOpenCodeSqliteSchema(db)
    db.prepare(`INSERT INTO session VALUES ('ses_minimal', 1777634000000, 1777634001000)`).run()
    db.close()

    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_minimal',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe('ses_minimal')
    expect(session!.filePath).toBe(path)
    expect(session!.title).toBe('OpenCode ses_mini')
    expect(session!.cwd).toBeNull()
    expect(session!.model).toBeNull()
    expect(session!.messageCount).toBe(0)
    expect(session!.totalTokens).toBe(0)
    expect(session!.previewMessages).toEqual([])
  })

  it('extracts model from older modelID schema', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_3',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_001_000,
      model: JSON.stringify({ modelID: 'claude-sonnet-4-5' })
    })
    db.close()
    const session = await parseOpenCodeSqliteSession({
      dbPath: path,
      sessionId: 'ses_3',
      platform: 'darwin'
    })
    expect(session).not.toBeNull()
    expect(session!.model).toBe('claude-sonnet-4-5')
  })

  it('captures every text part of the earliest user message and no later turn', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_fp',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_900_000
    })
    insertOpenCodeMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_fp',
      role: 'user',
      timeCreated: 1_777_634_000_000
    })
    insertOpenCodePart(db, {
      id: 'part_1a',
      messageId: 'msg_1',
      sessionId: 'ses_fp',
      timeCreated: 10,
      text: 'first ask line one'
    })
    insertOpenCodePart(db, {
      id: 'part_1b',
      messageId: 'msg_1',
      sessionId: 'ses_fp',
      timeCreated: 20,
      text: 'first ask line two'
    })
    // Non-text parts of the same message must not leak into the copied prompt.
    insertOpenCodePart(db, {
      id: 'part_1c',
      messageId: 'msg_1',
      sessionId: 'ses_fp',
      timeCreated: 30,
      type: 'tool',
      text: 'tool output blob'
    })
    insertOpenCodeMessage(db, {
      id: 'msg_2',
      sessionId: 'ses_fp',
      role: 'user',
      timeCreated: 1_777_634_500_000
    })
    insertOpenCodePart(db, {
      id: 'part_2a',
      messageId: 'msg_2',
      sessionId: 'ses_fp',
      timeCreated: 40,
      text: 'a later ask'
    })
    db.close()

    const session = await withFullFirstUserPromptCapture(() =>
      parseOpenCodeSqliteSession({ dbPath: path, sessionId: 'ses_fp', platform: 'darwin' })
    )

    expect(session!.firstUserPrompt).toBe('first ask line one\nfirst ask line two')
  })

  it('skips an earliest user message that has no text parts', async () => {
    const { db, path } = createTempDb()
    applyOpenCodeSqliteSchema(db)
    insertOpenCodeSession(db, {
      id: 'ses_fp2',
      timeCreated: 1_777_634_000_000,
      timeUpdated: 1_777_634_900_000
    })
    insertOpenCodeMessage(db, {
      id: 'msg_1',
      sessionId: 'ses_fp2',
      role: 'user',
      timeCreated: 1_777_634_000_000
    })
    insertOpenCodePart(db, {
      id: 'part_1a',
      messageId: 'msg_1',
      sessionId: 'ses_fp2',
      timeCreated: 10,
      type: 'tool',
      text: 'tool only'
    })
    insertOpenCodeMessage(db, {
      id: 'msg_2',
      sessionId: 'ses_fp2',
      role: 'user',
      timeCreated: 1_777_634_500_000
    })
    insertOpenCodePart(db, {
      id: 'part_2a',
      messageId: 'msg_2',
      sessionId: 'ses_fp2',
      timeCreated: 40,
      text: 'the real typed ask'
    })
    db.close()

    const session = await withFullFirstUserPromptCapture(() =>
      parseOpenCodeSqliteSession({ dbPath: path, sessionId: 'ses_fp2', platform: 'darwin' })
    )

    expect(session!.firstUserPrompt).toBe('the real typed ask')
  })
})
