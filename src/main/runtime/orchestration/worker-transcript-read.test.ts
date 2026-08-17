import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkerTranscript, type WorkerTranscriptReadDeps } from './worker-transcript-read'
import Database from '../../sqlite/sync-database'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptPageAfter,
  readOpenCodeTranscriptSignal
} from '../../native-chat/transcript-opencode-sqlite-query'

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    timestamp: '2026-07-24T12:00:00.000Z',
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

function grokMessage(id: string, text: string): string {
  return JSON.stringify({
    id,
    timestamp: '2026-07-24T12:00:00.000Z',
    type: 'assistant',
    content: text
  })
}

describe('worker transcript reads', () => {
  let directory: string
  let transcriptPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-transcript-'))
    transcriptPath = join(directory, 'rollout-session.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns a bounded tail followed by new messages from the exact file', async () => {
    await writeFile(
      transcriptPath,
      [codexMessage('one', 'first'), codexMessage('two', 'second'), codexMessage('three', 'third')]
        .join('\n')
        .concat('\n')
    )

    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 2
    })
    expect(initial).toMatchObject({
      ok: true,
      messages: [
        { id: 'two', blocks: [{ type: 'text', text: 'second' }] },
        { id: 'three', blocks: [{ type: 'text', text: 'third' }] }
      ],
      limited: true
    })
    if (!initial.ok) {
      throw new Error('Expected the initial transcript page')
    }

    await appendFile(transcriptPath, `{malformed}\n${codexMessage('four', 'fourth')}\n`)
    const appended = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: initial.nextOffset,
      limit: 2
    })

    expect(appended).toMatchObject({
      ok: true,
      messages: [{ id: 'four', blocks: [{ type: 'text', text: 'fourth' }] }],
      limited: false,
      warnings: ['1 malformed transcript record(s) were skipped.']
    })
  })

  it('pins archived reads to the transcript offset observed before release', async () => {
    await writeFile(
      transcriptPath,
      `${codexMessage('one', 'before release')}\n${codexMessage('two', 'release boundary')}\n`
    )
    const snapshot = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 1
    })
    if (!snapshot.ok) {
      throw new Error('Expected the release transcript probe')
    }
    await appendFile(transcriptPath, `${codexMessage('three', 'after release')}\n`)

    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        endOffset: snapshot.nextOffset,
        limit: 10
      })
    ).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'one', blocks: [{ type: 'text', text: 'before release' }] },
        { id: 'two', blocks: [{ type: 'text', text: 'release boundary' }] }
      ]
    })
    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        offset: snapshot.nextOffset,
        endOffset: snapshot.nextOffset,
        limit: 10
      })
    ).resolves.toMatchObject({ ok: true, messages: [], nextOffset: snapshot.nextOffset })
  })

  it('reports source changes and unsupported providers without guessing', async () => {
    await writeFile(transcriptPath, `${codexMessage('one', 'first')}\n`)

    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        offset: 10_000,
        limit: 2
      })
    ).resolves.toMatchObject({ ok: false, reason: 'source_changed' })

    await expect(
      readWorkerTranscript({
        agent: 'gemini',
        sessionId: 'session-other',
        transcriptPath,
        limit: 2
      })
    ).resolves.toEqual({ ok: false, reason: 'provider_unsupported', warnings: [] })
  })

  it('reuses the Native Chat Grok decoder', async () => {
    await writeFile(transcriptPath, `${grokMessage('grok-one', 'Grok structured output')}\n`)

    await expect(
      readWorkerTranscript({
        agent: 'grok',
        sessionId: 'session-grok',
        transcriptPath,
        limit: 2
      })
    ).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Grok structured output' }]
        }
      ]
    })
  })

  it('makes file-position fallback IDs opaque', async () => {
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: '2026-07-24T12:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'no provider id' }
      })}\n`
    )

    const result = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 2
    })

    expect(result).toMatchObject({
      ok: true,
      messages: [{ id: expect.stringMatching(/^worker-message-/) }],
      warnings: ['Transcript-backed message identifiers were made opaque.']
    })
    expect(result.ok && JSON.stringify(result.messages)).not.toContain(transcriptPath)
  })

  it('advances past a record larger than the forward scan window', async () => {
    await writeFile(transcriptPath, 'x'.repeat(8 * 1024 * 1024 + 10))

    const oversized = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: 0,
      limit: 2
    })
    expect(oversized).toMatchObject({
      ok: true,
      messages: [],
      limited: true,
      warnings: expect.arrayContaining([
        '1 oversized transcript record(s) were skipped.',
        'Transcript scanning stopped at the bounded byte limit; continue with the cursor.'
      ])
    })
    if (!oversized.ok) {
      throw new Error('Expected the oversized transcript page')
    }
    expect(oversized.nextOffset).toBe(8 * 1024 * 1024)

    await appendFile(transcriptPath, `\n${codexMessage('after', 'after oversized')}\n`)
    const continued = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: oversized.nextOffset,
      limit: 2
    })

    expect(continued).toMatchObject({
      ok: true,
      messages: [{ id: 'after', blocks: [{ type: 'text', text: 'after oversized' }] }],
      limited: false
    })
  })
})

describe('worker transcript reads (opencode SQLite)', () => {
  let tempDirs: string[] = []
  let openDbs: Database.Database[] = []

  afterEach(() => {
    // Why: Windows keeps the file locked while the handle is open (EPERM on rm).
    for (const db of openDbs) {
      db.close()
    }
    openDbs = []
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  function createDb(): { db: Database.Database; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-opencode-'))
    tempDirs.push(dir)
    const path = join(dir, 'opencode.db')
    const db = new Database(path)
    openDbs.push(db)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      INSERT INTO session (id) VALUES ('ses-1');
    `)
    return { db, path }
  }

  function insertMessage(db: Database.Database, id: string, time: number): void {
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(
      id,
      'ses-1',
      time,
      time,
      JSON.stringify({ role: id.startsWith('user') ? 'user' : 'assistant' })
    )
  }

  function insertTextPart(
    db: Database.Database,
    id: string,
    messageId: string,
    text: string
  ): void {
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(id, messageId, 'ses-1', 1_000, JSON.stringify({ type: 'text', text }))
  }

  function insertStepStart(db: Database.Database, id: string, messageId: string): void {
    db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(id, messageId, 'ses-1', 1_000, JSON.stringify({ type: 'step-start' }))
  }

  function rawRowid(db: Database.Database, id: string): number {
    return (db.prepare('SELECT rowid AS r FROM message WHERE id = ?').get(id) as { r: number }).r
  }

  function opencodeDeps(path: string): WorkerTranscriptReadDeps {
    return {
      opencode: {
        resolveDbPath: async () => path,
        readSignal: (dbPath, sessionId) =>
          Promise.resolve(readOpenCodeTranscriptSignal(dbPath, sessionId)),
        readPage: (args) => Promise.resolve(readOpenCodeTranscriptPage(args)),
        readPageAfter: (args) => Promise.resolve(readOpenCodeTranscriptPageAfter(args))
      }
    }
  }

  it('returns the newest window with a cursor covering non-renderable rows', async () => {
    const { db, path } = createDb()
    for (const id of ['user-1', 'assistant-2', 'user-3']) {
      insertMessage(db, id, 1_000)
      insertTextPart(db, `prt-${id}`, id, `text ${id}`)
    }
    // Newest row never renders (step-start only) — the cursor must still cover it.
    insertMessage(db, 'assistant-4', 2_000)
    insertStepStart(db, 'prt-assistant-4', 'assistant-4')

    const initial = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        limit: 2
      },
      opencodeDeps(path)
    )
    expect(initial).toMatchObject({
      ok: true,
      filePath: path,
      // limit counts renderable messages, so the non-renderable newest row
      // (assistant-4) is walked past, not charged against the budget.
      messages: [{ id: 'assistant-2' }, { id: 'user-3' }],
      // The raw max rowid, not the last renderable item's.
      nextOffset: rawRowid(db, 'assistant-4')
    })
  })

  it('continues from the cursor with only rows appended after it', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'user-1', 1_000)
    insertTextPart(db, 'prt-1', 'user-1', 'first')

    const initial = await readWorkerTranscript(
      { agent: 'opencode', sessionId: 'ses-1' },
      opencodeDeps(path)
    )
    if (!initial.ok) {
      throw new Error('Expected the initial opencode page')
    }
    expect(initial.messages.map((message) => message.id)).toEqual(['user-1'])

    insertMessage(db, 'assistant-2', 2_000)
    insertTextPart(db, 'prt-2', 'assistant-2', 'second')

    const appended = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: initial.nextOffset
      },
      opencodeDeps(path)
    )
    expect(appended).toMatchObject({
      ok: true,
      messages: [{ id: 'assistant-2', blocks: [{ type: 'text', text: 'second' }] }],
      limited: false
    })

    // At rest the cursor holds and the continuation is a no-op, like the JSONL path.
    if (!appended.ok) {
      throw new Error('Expected the appended opencode page')
    }
    const settled = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: appended.nextOffset
      },
      opencodeDeps(path)
    )
    expect(settled).toMatchObject({ ok: true, messages: [] })
  })

  it('freezes an archived boundary so neither read leaks newer rows', async () => {
    const { db, path } = createDb()
    for (const id of ['user-1', 'user-2', 'user-3']) {
      insertMessage(db, id, 1_000)
      insertTextPart(db, `prt-${id}`, id, `text ${id}`)
    }
    const endOffset = rawRowid(db, 'user-2')

    const initial = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        endOffset
      },
      opencodeDeps(path)
    )
    expect(initial).toMatchObject({
      ok: true,
      messages: [{ id: 'user-1' }, { id: 'user-2' }],
      nextOffset: endOffset
    })

    insertMessage(db, 'user-after-pin', 2_000)
    insertTextPart(db, 'prt-after-pin', 'user-after-pin', 'must not leak')

    const forward = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: endOffset,
        endOffset
      },
      opencodeDeps(path)
    )
    expect(forward).toMatchObject({ ok: true, messages: [] })
  })

  it('reports source_changed when the DB max rowid falls below the frozen boundary', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'user-1', 1_000)
    insertTextPart(db, 'prt-1', 'user-1', 'first')
    // A rebuilt DB resets rowids; a boundary above the current max can never be
    // reached again — the pinned source changed.
    const staleEndOffset = rawRowid(db, 'user-1') + 100

    await expect(
      readWorkerTranscript(
        {
          agent: 'opencode',
          sessionId: 'ses-1',
          endOffset: staleEndOffset
        },
        opencodeDeps(path)
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('reports source_changed when an unpinned continuation cursor exceeds the max rowid', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'user-1', 1_000)
    insertTextPart(db, 'prt-1', 'user-1', 'first')
    // A rebuilt DB resets rowids; a cursor above the current max can never be
    // reached again — the source changed, mirroring a shrunken JSONL file.
    const staleOffset = rawRowid(db, 'user-1') + 100

    await expect(
      readWorkerTranscript(
        {
          agent: 'opencode',
          sessionId: 'ses-1',
          offset: staleOffset
        },
        opencodeDeps(path)
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('reports transcript_missing for an absent session or DB', async () => {
    const { path } = createDb()
    await expect(
      readWorkerTranscript({ agent: 'opencode', sessionId: 'missing-session' }, opencodeDeps(path))
    ).resolves.toEqual({ ok: false, reason: 'transcript_missing', warnings: [] })

    await expect(
      readWorkerTranscript(
        { agent: 'opencode', sessionId: 'ses-1' },
        { opencode: { ...opencodeDeps(path).opencode!, resolveDbPath: async () => null } }
      )
    ).resolves.toEqual({ ok: false, reason: 'transcript_missing', warnings: [] })
  })

  it('maps a worker failure to transcript_unreadable without a parse verdict', async () => {
    const { path } = createDb()
    await expect(
      readWorkerTranscript(
        { agent: 'opencode', sessionId: 'ses-1' },
        {
          opencode: {
            ...opencodeDeps(path).opencode!,
            readSignal: () => Promise.reject(new Error('worker crashed'))
          }
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'transcript_unreadable', warnings: [] })
  })
})
