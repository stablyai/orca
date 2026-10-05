import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleOpenCodeSqliteRequest } from './session-scanner-opencode-sqlite-dispatch'
import { splitOpenCodeSqliteCandidate } from './session-scanner-opencode-sqlite-paths'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import SyncDatabase from '../sqlite/sync-database'

// Why readers and not casts: the worker dispatch returns `value: unknown` on purpose — it
// crosses a process boundary. Narrowing here keeps the repo's no-assertions rule and fails
// the test with a readable message if the payload shape ever changes.
function readCandidates(value: unknown): { agent: string; path: string }[] {
  if (typeof value !== 'object' || value === null || !('candidates' in value)) {
    throw new Error('expected a listing payload with candidates')
  }
  const { candidates } = value
  if (!Array.isArray(candidates)) {
    throw new Error('expected candidates to be an array')
  }
  return candidates.map((candidate) => {
    const agent = readStringField(candidate, 'agent')
    const file = isRecord(candidate) ? candidate['file'] : null
    return { agent, path: readStringField(file, 'path') }
  })
}

function readMessageTexts(value: unknown): { text: string }[] {
  if (typeof value !== 'object' || value === null || !('messages' in value)) {
    throw new Error('expected a capture payload with messages')
  }
  const { messages } = value
  if (!Array.isArray(messages)) {
    throw new Error('expected messages to be an array')
  }
  return messages.map((message) => ({ text: readStringField(message, 'text') }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStringField(value: unknown, field: string): string {
  const read = isRecord(value) ? value[field] : null
  if (typeof read !== 'string') {
    throw new Error(`expected a string \`${field}\``)
  }
  return read
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
  directories.length = 0
})

describe('ZCode AI Vault SQLite worker', () => {
  it.each(['message', 'part', 'both'] as const)(
    'reads partially migrated %s sequence columns and keeps legacy NULL rows last',
    async (tables) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-legacy-sequence-'))
      directories.push(directory)
      const dbPath = join(directory, 'db.sqlite')
      writeOpenCodeSqliteDatabase(dbPath, [
        {
          id: 'legacy-session',
          turns: [
            { role: 'user', parts: ['first', 'second', 'legacy part'] },
            { role: 'user', parts: ['legacy message'] }
          ]
        }
      ])
      const db = new SyncDatabase(dbPath)
      try {
        if (tables !== 'part') {
          db.exec(`ALTER TABLE message ADD COLUMN sequence INTEGER;
                   UPDATE message SET sequence = 0 WHERE rowid = 1;
                   UPDATE message SET time_created = 1 WHERE rowid = 2;`)
        }
        if (tables !== 'message') {
          db.exec(`ALTER TABLE part ADD COLUMN sequence INTEGER;
                   UPDATE part SET sequence = rowid WHERE rowid <= 2;
                   UPDATE part SET time_created = 1 WHERE rowid = 3;`)
        }
      } finally {
        db.close()
      }
      const captured = await handleOpenCodeSqliteRequest({
        id: 8,
        kind: 'capture',
        agent: 'zcode',
        dbPath,
        sessionId: 'legacy-session',
        platform: 'win32'
      })
      expect(captured.ok).toBe(true)
      if (!captured.ok) {
        return
      }
      expect(readMessageTexts(captured.value)).toEqual([
        { text: 'first\nsecond\nlegacy part' },
        { text: 'legacy message' }
      ])
    }
  )

  it('uses stored message and part sequence for first prompt, preview, and search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-sequence-'))
    directories.push(directory)
    const dbPath = join(directory, 'db.sqlite')
    writeOpenCodeSqliteDatabase(dbPath, [
      {
        id: 'ordered-session',
        turns: [
          { role: 'user', parts: ['first prompt start', 'first prompt end'] },
          { role: 'assistant', parts: ['first response'] },
          { role: 'user', parts: ['second prompt'] },
          { role: 'assistant', parts: ['second response start', 'second response end'] }
        ]
      }
    ])
    const db = new SyncDatabase(dbPath)
    try {
      db.exec(`ALTER TABLE message ADD COLUMN sequence INTEGER;
               ALTER TABLE part ADD COLUMN sequence INTEGER;
               UPDATE message SET sequence = rowid, time_created = time_created - rowid * 120000;
               UPDATE part SET sequence = rowid, time_created = time_created - rowid * 120000;`)
    } finally {
      db.close()
    }
    const parsed = await handleOpenCodeSqliteRequest({
      id: 6,
      kind: 'parse',
      agent: 'zcode',
      dbPath,
      sessionId: 'ordered-session',
      platform: 'darwin',
      fullFirstUserPrompt: true
    })
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        firstUserPrompt: 'first prompt start\nfirst prompt end',
        previewMessagesTruncated: true,
        previewMessages: [
          { text: 'first prompt end' },
          { text: 'first response' },
          { text: 'second prompt' },
          { text: 'second response start' },
          { text: 'second response end' }
        ]
      }
    })
    const captured = await handleOpenCodeSqliteRequest({
      id: 7,
      kind: 'capture',
      agent: 'zcode',
      dbPath,
      sessionId: 'ordered-session',
      platform: 'darwin'
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    expect(readMessageTexts(captured.value)).toEqual([
      { text: 'first prompt start\nfirst prompt end' },
      { text: 'first response' },
      { text: 'second prompt' },
      { text: 'second response start\nsecond response end' }
    ])
  })

  it('lists, parses, and captures ZCode sessions without labelling them OpenCode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-ai-vault-'))
    directories.push(directory)
    const dbPath = join(directory, 'db.sqlite')
    writeOpenCodeSqliteDatabase(dbPath, [
      {
        id: 'zcode-session',
        directory: '/repo',
        title: 'ZCode task',
        turns: [
          { role: 'user', parts: ['Fix the import'] },
          { role: 'assistant', parts: ['Import fixed'] }
        ]
      }
    ])

    const listed = await handleOpenCodeSqliteRequest({
      id: 1,
      kind: 'list',
      agent: 'zcode',
      dbPaths: [dbPath],
      limit: 10
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) {
      return
    }
    const candidates = readCandidates(listed.value)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.agent).toBe('zcode')
    expect(splitOpenCodeSqliteCandidate(candidates[0]!.path, 'zcode')).toEqual({
      dbPath,
      sessionId: 'zcode-session'
    })
    expect(splitOpenCodeSqliteCandidate(candidates[0]!.path)).toBeNull()

    const parsed = await handleOpenCodeSqliteRequest({
      id: 2,
      kind: 'parse',
      agent: 'zcode',
      dbPath,
      sessionId: 'zcode-session',
      platform: 'darwin'
    })
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        agent: 'zcode',
        title: 'ZCode task',
        resumeCommand: "cd '/repo' && zcode --resume 'zcode-session'"
      }
    })

    const captured = await handleOpenCodeSqliteRequest({
      id: 3,
      kind: 'capture',
      agent: 'zcode',
      dbPath,
      sessionId: 'zcode-session',
      platform: 'darwin'
    })
    expect(captured).toMatchObject({ ok: true, value: { session: { agent: 'zcode' } } })
    if (!captured.ok) {
      return
    }
    expect(readMessageTexts(captured.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Fix the import' })])
    )
  })

  it('excludes ZCode hidden transcript messages from preview and search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-ai-vault-'))
    directories.push(directory)
    const dbPath = join(directory, 'db.sqlite')
    writeOpenCodeSqliteDatabase(dbPath, [
      {
        id: 'visible-session',
        turns: [
          { role: 'user', parts: ['internal reminder'] },
          { role: 'user', parts: ['visible request'] },
          { role: 'assistant', parts: ['visible response'] }
        ]
      }
    ])
    const db = new SyncDatabase(dbPath)
    try {
      db.prepare(
        "UPDATE message SET data = json_set(data, '$.semantics.transcriptVisibility', 'hidden') WHERE id LIKE '%-msg-0-%'"
      ).run()
    } finally {
      db.close()
    }

    const parsed = await handleOpenCodeSqliteRequest({
      id: 4,
      kind: 'parse',
      agent: 'zcode',
      dbPath,
      sessionId: 'visible-session',
      platform: 'darwin',
      fullFirstUserPrompt: true
    })
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        messageCount: 2,
        firstUserPrompt: 'visible request'
      }
    })
    if (!parsed.ok) {
      return
    }
    expect(JSON.stringify(parsed.value)).not.toContain('internal reminder')

    const captured = await handleOpenCodeSqliteRequest({
      id: 5,
      kind: 'capture',
      agent: 'zcode',
      dbPath,
      sessionId: 'visible-session',
      platform: 'darwin'
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    expect(JSON.stringify(captured.value)).not.toContain('internal reminder')
  })
})
