import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkerTranscript, type WorkerTranscriptReadDeps } from './worker-transcript-read'
import type { IFilesystemProvider } from '../../providers/types'
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
      expectedSourceFingerprint: initial.sourceFingerprint,
      expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
      limit: 2
    })

    expect(appended).toMatchObject({
      ok: true,
      messages: [{ id: 'four', blocks: [{ type: 'text', text: 'fourth' }] }],
      limited: false,
      warnings: ['1 malformed transcript record(s) were skipped.']
    })
  })

  it.each([
    ['equal-size', 0],
    ['larger', 64]
  ])('rejects a same-inode truncate/regrow at %s', async (_label, extraBytes) => {
    await writeFile(
      transcriptPath,
      `${codexMessage('one', 'original transcript with enough padding for equal-size rewrite')}\n`
    )
    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 10
    })
    if (!initial.ok) {
      throw new Error('Expected the original transcript page')
    }
    const before = await stat(transcriptPath, { bigint: true })
    const replacementLine = `${codexMessage('other', 'unrelated rewrite')}\n`
    const replacement = replacementLine.padEnd(initial.nextOffset + extraBytes, ' ')

    await writeFile(transcriptPath, replacement)

    const after = await stat(transcriptPath, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.dev).toBe(before.dev)
    expect(Number(after.size)).toBeGreaterThanOrEqual(initial.nextOffset)
    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        offset: initial.nextOffset,
        expectedSourceFingerprint: initial.sourceFingerprint,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
        limit: 10
      })
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
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
      expectedSourceFingerprint: oversized.sourceFingerprint,
      expectedBoundaryCheckpoint: oversized.boundaryCheckpoint,
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node:sqlite rows are unknown; the SELECT projects exactly one `r` integer column.
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
      nextOffset: rawRowid(db, 'assistant-4'),
      // The window stopped at the limit — the cursor owner must keep tailing.
      limited: true,
      clipping: ['message_limit_or_scan_window']
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

  it('attests every success with a stable wire checkpoint', async () => {
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
    // The exact-output wire throws sourceChanged for a transcript cursor
    // without a checkpoint, so the checkpoint must always be present and
    // chain to the cursor; the fingerprint pins the DB file identity.
    expect(initial.boundaryCheckpoint).toBe(String(initial.nextOffset))
    expect(initial.sourceFingerprint).toMatch(/^opencode:.*:ses-1:\d+:\d+$/)

    insertMessage(db, 'assistant-2', 2_000)
    insertTextPart(db, 'prt-2', 'assistant-2', 'second')

    const appended = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: initial.nextOffset,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint
      },
      opencodeDeps(path)
    )
    if (!appended.ok) {
      throw new Error('Expected the appended opencode page')
    }
    expect(appended.boundaryCheckpoint).toBe(String(appended.nextOffset))
    // The fingerprint pins the source identity across appends — a high-water
    // mark here would flip the identity on every new message and break the
    // cursor chain the exact-output reader re-attests each read.
    expect(appended.sourceFingerprint).toBe(initial.sourceFingerprint)
  })

  it('continues across an append with the attested checkpoint', async () => {
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

    insertMessage(db, 'assistant-2', 2_000)
    insertTextPart(db, 'prt-2', 'assistant-2', 'second')

    // A normal append must not trip source_changed: the chained checkpoint
    // still matches the offset even though the DB grew.
    const appended = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: initial.nextOffset,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint
      },
      opencodeDeps(path)
    )
    expect(appended).toMatchObject({
      ok: true,
      messages: [{ id: 'assistant-2', blocks: [{ type: 'text', text: 'second' }] }]
    })
  })

  it('rejects a continuation whose checkpoint does not chain to its offset', async () => {
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

    // The cursor and the position disagree about the boundary — the pinned
    // source changed even though the rows are still addressable.
    await expect(
      readWorkerTranscript(
        {
          agent: 'opencode',
          sessionId: 'ses-1',
          offset: initial.nextOffset,
          expectedBoundaryCheckpoint: 'stale-checkpoint'
        },
        opencodeDeps(path)
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('flips the fingerprint when the DB file is replaced, even regrown past the cursor', async () => {
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
    const before = initial.sourceFingerprint

    // Same path, new file, regrown past the old cursor: the rowid guard alone
    // cannot see this, so the fingerprint must flip or the next read would
    // silently serve a different DB's rows under a valid cursor.
    // (Untrack the closed handle: afterEach closes every tracked DB.)
    db.close()
    openDbs.splice(openDbs.indexOf(db), 1)
    rmSync(path, { force: true })
    const replacement = new Database(path)
    openDbs.push(replacement)
    replacement.exec(`
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
    insertMessage(replacement, 'user-a', 1_000)
    insertTextPart(replacement, 'prt-a', 'user-a', 'other db')
    insertMessage(replacement, 'user-b', 2_000)
    insertTextPart(replacement, 'prt-b', 'user-b', 'other db')

    const reread = await readWorkerTranscript(
      { agent: 'opencode', sessionId: 'ses-1' },
      opencodeDeps(path)
    )
    if (!reread.ok) {
      throw new Error('Expected the replacement opencode page')
    }
    expect(rawRowid(replacement, 'user-b')).toBeGreaterThanOrEqual(initial.nextOffset)
    expect(reread.sourceFingerprint).not.toBe(before)
  })

  it('reports transcript_unreadable when DB discovery throws', async () => {
    // A throwing filesystem scan must come back as a retryable value result,
    // not a leaked rejection the worker pipeline cannot handle.
    await expect(
      readWorkerTranscript(
        { agent: 'opencode', sessionId: 'ses-1' },
        {
          opencode: {
            resolveDbPath: async () => {
              throw new Error('EACCES')
            }
          }
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'transcript_unreadable', warnings: [] })
  })

  it('reuses the cached file identity when the stat fails mid-stream', async () => {
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

    // The file disappears (stat fails on every retry) while the worker-backed
    // signal/page reads keep returning data: minting the path-keyed form here
    // would flip the identity on the next stat success and throw a spurious
    // source_changed at the cursor owner — the cached identity must hold.
    db.close()
    openDbs.splice(openDbs.indexOf(db), 1)
    rmSync(path, { force: true })

    const reread = await readWorkerTranscript(
      {
        agent: 'opencode',
        sessionId: 'ses-1',
        offset: initial.nextOffset,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint
      },
      {
        opencode: {
          resolveDbPath: async () => path,
          readSignal: async () => ({
            messageCount: 1,
            partCount: 1,
            maxMessageRowId: initial.nextOffset,
            maxPartTimeUpdated: 1_000
          }),
          readPageAfter: async () => ({
            items: [],
            hasMore: false,
            nextMessageRowId: initial.nextOffset
          })
        }
      }
    )
    expect(reread).toMatchObject({ ok: true, sourceFingerprint: initial.sourceFingerprint })
  })

  it('reports source_changed when a pinned continuation outlives its session row', async () => {
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

    db.exec("DELETE FROM session WHERE id = 'ses-1'")
    await expect(
      readWorkerTranscript(
        {
          agent: 'opencode',
          sessionId: 'ses-1',
          offset: initial.nextOffset,
          expectedBoundaryCheckpoint: initial.boundaryCheckpoint
        },
        opencodeDeps(path)
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('reports source_changed when the session vanishes between signal and forward', async () => {
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

    // readPageAfter null means the session row is gone; a pinned read must
    // treat it as source_changed (transcript_missing sticky-kills the stream).
    const deps = opencodeDeps(path)
    await expect(
      readWorkerTranscript(
        {
          agent: 'opencode',
          sessionId: 'ses-1',
          offset: initial.nextOffset,
          expectedBoundaryCheckpoint: initial.boundaryCheckpoint
        },
        { opencode: { ...deps.opencode!, readPageAfter: () => Promise.resolve(null) } }
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('rejects non-finite cursors instead of minting poisoned checkpoints', async () => {
    const { db, path } = createDb()
    insertMessage(db, 'user-1', 1_000)
    insertTextPart(db, 'prt-1', 'user-1', 'first')

    await expect(
      readWorkerTranscript(
        { agent: 'opencode', sessionId: 'ses-1', offset: Number.NaN },
        opencodeDeps(path)
      )
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })

    const signal = await readOpenCodeTranscriptSignal(path, 'ses-1')
    await expect(
      readWorkerTranscript(
        { agent: 'opencode', sessionId: 'ses-1' },
        {
          opencode: {
            ...opencodeDeps(path).opencode!,
            readSignal: () =>
              Promise.resolve(signal ? { ...signal, maxMessageRowId: Number.NaN } : null)
          }
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'transcript_unreadable', warnings: [] })
  })

  it('falls back to terminal for remote or WSL opencode workers without touching local disk', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately empty stub — the test asserts remote/WSL reads never touch the provider.
    const remote = {} as unknown as IFilesystemProvider
    await expect(
      readWorkerTranscript({ agent: 'opencode', sessionId: 'ses-1', filesystemProvider: remote })
    ).resolves.toEqual({ ok: false, reason: 'remote_capability_unavailable', warnings: [] })
    await expect(
      readWorkerTranscript({ agent: 'opencode', sessionId: 'ses-1', wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ ok: false, reason: 'remote_capability_unavailable', warnings: [] })
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

  it('advances the initial cursor past rows interleaved between signal and page', async () => {
    const { db, path } = createDb()
    for (const id of ['user-1', 'user-2', 'user-3']) {
      insertMessage(db, id, 1_000)
      insertTextPart(db, `prt-${id}`, id, `text ${id}`)
    }
    const staleMax = rawRowid(db, 'user-2')
    // A row lands after the signal read but before the page read.
    insertMessage(db, 'user-4', 2_000)
    insertTextPart(db, 'prt-user-4', 'user-4', 'text user-4')

    const deps: WorkerTranscriptReadDeps = {
      opencode: {
        resolveDbPath: async () => path,
        // First signal is stale (user-2 era); later reads see the real DB.
        readSignal: (() => {
          let signalReads = 0
          return () => {
            signalReads++
            if (signalReads === 1) {
              return Promise.resolve({
                messageCount: 2,
                partCount: 2,
                maxMessageRowId: staleMax,
                maxPartTimeUpdated: 1_000
              })
            }
            return Promise.resolve(readOpenCodeTranscriptSignal(path, 'ses-1'))
          }
        })(),
        readPage: (args) => Promise.resolve(readOpenCodeTranscriptPage(args)),
        readPageAfter: (args) => Promise.resolve(readOpenCodeTranscriptPageAfter(args))
      }
    }

    const initial = await readWorkerTranscript({ agent: 'opencode', sessionId: 'ses-1' }, deps)
    if (!initial.ok) {
      throw new Error('Expected the initial opencode page')
    }
    // The cursor must cover the interleaved row.
    expect(initial.nextOffset).toBe(rawRowid(db, 'user-4'))

    const continuation = await readWorkerTranscript(
      { agent: 'opencode', sessionId: 'ses-1', offset: initial.nextOffset },
      deps
    )
    if (!continuation.ok) {
      throw new Error('Expected the opencode continuation')
    }
    expect(continuation.messages).toEqual([])
  })
})
