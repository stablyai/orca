import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { readJournalBlob } from './journal-blob-store'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE } from './journal-log-file'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'
import { journalDirectoryFor, journalPathSegment } from './journal-paths'
import {
  AgentSessionJournalError,
  openAgentSessionJournal,
  type AgentSessionJournal
} from './journal-store'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('sequences', () => {
  it('assigns a contiguous sequence with no gaps or reuse under concurrent appends', async () => {
    const journal = await open()
    const results = await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
      )
    )
    const sequences = results.map((result) => result.cursor.sequence)
    expect(new Set(sequences).size).toBe(25)
    expect(sequences.slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_unused, index) => index + 2)
    )
  })

  it('serializes revisions of one item so the last write wins deterministically', async () => {
    const journal = await open()
    const results = await Promise.all([
      journal.appendItem(item(0), body('a'), { fence: 1 }),
      journal.appendItem(item(0), body('b'), { fence: 1 }),
      journal.appendItem(item(0), body('c'), { fence: 1 })
    ])
    expect(results.map((result) => result.revision)).toEqual([1, 2, 3])
    expect(journal.snapshot().items).toHaveLength(1)
    expect(journal.snapshot().items[0]?.revision).toBe(3)
  })

  it('assigns a revision above a tombstone when an item is re-created', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('first'), { fence: 1 })
    await journal.appendTombstone(item(0), { fence: 1 })

    const recreated = await journal.appendItem(item(0), body('back'), { fence: 1 })
    expect(recreated.revision).toBe(3)
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('back')])
    expect((await open()).snapshot()).toEqual(journal.snapshot())
  })
})

describe('fences', () => {
  it('rejects an append from a writer behind the journal', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await expect(journal.appendItem(item(1), body('b'), { fence: 6 })).rejects.toBeInstanceOf(
      AgentSessionJournalError
    )
  })

  it('keeps accepting appends after a rejected one', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await journal.appendItem(item(1), body('b'), { fence: 6 }).catch(() => undefined)
    await journal.appendItem(item(2), body('c'), { fence: 7 })
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('a'), body('c')])
  })

  it('rejects rollover and compaction from a stale writer', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 7 })

    await expect(journal.rollEpoch('handle_forked', 6)).rejects.toMatchObject({
      code: 'journal_stale_fence'
    })
    await expect(journal.compact(6)).rejects.toMatchObject({ code: 'journal_stale_fence' })
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('a')])
  })
})

describe('replay', () => {
  it('reopens to the same render model the live writer held', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.appendItem(item(1), body('b'), { fence: 1 })
    await journal.appendItem(item(0), body('a2'), { fence: 1 })
    await journal.appendTombstone(item(1), { fence: 1 })
    const live = journal.snapshot()

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(live)
  })

  it('refuses rows whose JSON form would change the live render model', async () => {
    const journal = await open()
    for (const input of [undefined, Number.NaN]) {
      await expect(
        journal.appendItem(
          item(0),
          { kind: 'tool-call', name: 'bash', input, state: 'running' },
          { fence: 1 }
        )
      ).rejects.toMatchObject({ code: 'journal_invalid_row' })
    }

    await journal.appendItem(item(0), body('persisted'), { fence: 1 })
    expect((await open()).snapshot()).toEqual(journal.snapshot())
  })

  it('serves a resume from a cursor and refuses one from a stale epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const cursor = journal.cursor()
    await journal.appendItem(item(1), body('b'), { fence: 1 })

    const resumed = journal.readSince(cursor)
    expect(resumed.ok && resumed.rows).toHaveLength(1)

    await journal.rollEpoch('handle_forked', 2)
    expect(journal.readSince(cursor)).toEqual({ ok: false, reset: 'epoch_changed' })
  })

  it('rebuilds from a clean epoch after a rollover', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.rollEpoch('unreconcilable_prefix', 2)
    expect(journal.snapshot().items).toHaveLength(0)

    const reopened = await open()
    expect(reopened.epoch).toBe(journal.epoch)
    expect(reopened.snapshot().items).toHaveLength(0)
  })

  it('serializes an append requested during rollover into the new epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('old epoch'), { fence: 1 })

    const rolled = journal.rollEpoch('handle_forked', 2)
    const appended = journal.appendItem(item(1), body('new epoch'), { fence: 2 })
    await Promise.all([rolled, appended])

    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([body('new epoch')])
    expect((await open()).snapshot()).toEqual(journal.snapshot())
  })

  it('does not reuse the epoch sequence when rollover crashes before rewriting the log', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('old epoch'), { fence: 1 })
    const logBefore = await readFile(join(root, JOURNAL_LOG_FILE), 'utf-8')

    await journal.rollEpoch('handle_forked', 2)
    await writeFile(join(root, JOURNAL_LOG_FILE), logBefore, 'utf-8')

    const reopened = await open()
    expect(reopened.cursor()).toEqual({ epoch: journal.epoch, sequence: 1 })
    const appended = await reopened.appendItem(item(1), body('new epoch'), { fence: 2 })
    expect(appended.cursor.sequence).toBe(2)
    expect((await open()).snapshot()).toEqual(reopened.snapshot())
  })

  it('rolls the epoch when the log lost a row', async () => {
    const journal = await open()
    for (let index = 0; index < 4; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const before = journal.epoch
    const logPath = join(root, JOURNAL_LOG_FILE)
    const lines = (await readFile(logPath, 'utf-8')).split('\n').filter(Boolean)
    await writeFile(logPath, `${[...lines.slice(0, 2), ...lines.slice(3)].join('\n')}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.epoch).not.toBe(before)
    expect(reopened.snapshot().items).toHaveLength(0)
  })

  it('rolls the epoch when one sequence names two different rows', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('first'), { fence: 1 })
    const before = journal.epoch
    const logPath = join(root, JOURNAL_LOG_FILE)
    const conflicting = JSON.stringify({
      v: 1,
      kind: 'item',
      epoch: before,
      seq: 2,
      fence: 1,
      ts: 1_002,
      itemId: 'conflicting-item',
      revision: 1,
      body: body('conflict')
    })
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}${conflicting}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.epoch).not.toBe(before)
    expect(reopened.snapshot().items).toEqual([])
  })
})

describe('compaction and retention', () => {
  it('folds the prefix into the snapshot and keeps serving the retained tail', async () => {
    const journal = await open({ compaction: { minTailRows: 2, retainTailMs: 0 } })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const rendered = journal.snapshot()
    const tip = journal.cursor()
    await journal.compact(1)

    expect(journal.snapshot()).toEqual(rendered)
    expect(journal.readSince({ epoch: tip.epoch, sequence: 1 })).toEqual({
      ok: false,
      reset: 'cursor_compacted'
    })
    const nearTip = journal.readSince({ epoch: tip.epoch, sequence: tip.sequence - 1 })
    expect(nearTip.ok && nearTip.rows).toHaveLength(1)

    const reopened = await open({ compaction: { minTailRows: 2, retainTailMs: 0 } })
    expect(reopened.snapshot()).toEqual(rendered)
    expect(reopened.compactionBoundary).toBe(tip.sequence)
  })

  it('publishes the snapshot and its tail as one write, so a crash before the log rewrite loses nothing', async () => {
    const journal = await open({ compaction: { minTailRows: 2, retainTailMs: 0 } })
    for (let index = 0; index < 5; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const rendered = journal.snapshot()
    const logBefore = await readFile(join(root, JOURNAL_LOG_FILE), 'utf-8')
    await journal.compact(1)
    // Simulate the crash: the snapshot landed, the truncation did not.
    await writeFile(join(root, JOURNAL_LOG_FILE), logBefore, 'utf-8')

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(rendered)
    expect(reopened.snapshot().items).toHaveLength(5)
  })

  it('serializes compaction behind an append so the log rewrite cannot discard it', async () => {
    const journal = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await journal.appendItem(item(0), body('before'), { fence: 1 })

    const appended = journal.appendItem(item(1), body('during'), { fence: 1 })
    await Promise.all([appended, journal.compact(1)])

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(journal.snapshot())
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('before'),
      body('during')
    ])
  })

  it('preserves tombstones and the highest writer fence across compaction', async () => {
    const journal = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await journal.appendItem(item(0), body('removed'), { fence: 7 })
    await journal.appendTombstone(item(0), { fence: 7 })
    await journal.compact(7)

    const reopened = await open()
    await expect(
      reopened.appendItem(item(1), body('stale writer'), { fence: 6 })
    ).rejects.toMatchObject({ code: 'journal_stale_fence' })
    const recreated = await reopened.appendItem(item(0), body('re-created'), { fence: 7 })
    expect(recreated.revision).toBe(3)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('re-created')])
  })

  it('prunes blobs no live row references and keeps the ones that survive', async () => {
    const journal = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    const kept = boundPayload('k'.repeat(64), {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 8
    })
    const dropped = boundPayload('d'.repeat(64), {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 8
    })
    const { putJournalBlob } = await import('./journal-blob-store')
    await putJournalBlob(root, kept.digest, 'k'.repeat(64))
    await putJournalBlob(root, dropped.digest, 'd'.repeat(64))
    await journal.appendItem(
      item(0),
      { kind: 'tool-call', name: 'bash', input: {}, state: 'completed', output: kept },
      { fence: 1 }
    )
    await journal.compact(1)

    expect(await readJournalBlob(root, kept.digest)).toBe('k'.repeat(64))
    expect(await readJournalBlob(root, dropped.digest)).toBeNull()
  })

  it('keeps blobs referenced by rows that remain replayable after compaction', async () => {
    const journal = await open({ compaction: { minTailRows: 3, retainTailMs: 0 } })
    const payload = 'old output'.repeat(16)
    const bounded = boundPayload(payload, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 8
    })
    const { putJournalBlob } = await import('./journal-blob-store')
    await putJournalBlob(root, bounded.digest, payload)
    await journal.appendItem(
      item(0),
      { kind: 'tool-call', name: 'bash', input: {}, state: 'completed', output: bounded },
      { fence: 1 }
    )
    await journal.appendItem(item(0), body('replacement'), { fence: 1 })
    await journal.compact(1)

    const replay = journal.readSince({ epoch: journal.epoch, sequence: 1 })
    expect(
      replay.ok &&
        replay.rows.some(
          (row) =>
            row.kind === 'item' &&
            row.body.kind === 'tool-call' &&
            row.body.output?.digest === bounded.digest
        )
    ).toBe(true)
    expect(await readJournalBlob(root, bounded.digest)).toBe(payload)
  })

  it('refuses a blob name that is not a bare digest, on either slash', async () => {
    const { putJournalBlob } = await import('./journal-blob-store')
    // A corrupt or crafted row must not steer a read or a write out of the store.
    for (const name of ['../../escape', '..\\..\\escape', 'nested/name', 'NOTHEX']) {
      expect(await readJournalBlob(root, name)).toBeNull()
      await expect(putJournalBlob(root, name, 'payload')).rejects.toThrow('sha256 digest')
    }
  })
})

describe('bounds', () => {
  it('marks a clipped payload instead of dropping bytes silently', () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 16 }
    const bounded = boundPayload('x'.repeat(4_096), limits)
    expect(bounded.truncated).toBe(true)
    expect(bounded.head).toHaveLength(16)
    expect(bounded.byteLength).toBe(4_096)
    expect(boundInlineText('x'.repeat(4_096), limits).text).toContain('output truncated')
  })

  it('never splits a multi-byte character across the bound', () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 4 }
    // Each character is three bytes, so a naive slice would land mid-sequence.
    const bounded = boundPayload('日本語テスト', limits)
    expect(bounded.head).toBe('日')
    expect(Buffer.byteLength(bounded.head, 'utf8')).toBeLessThanOrEqual(4)
  })

  it('leaves a payload inside the bound untouched', () => {
    const bounded = boundPayload('small', DEFAULT_JOURNAL_PAYLOAD_LIMITS)
    expect(bounded.truncated).toBe(false)
    expect(bounded.head).toBe('small')
    expect(boundInlineText('small', DEFAULT_JOURNAL_PAYLOAD_LIMITS).text).toBe('small')
  })

  it('refuses an append past the per-session size bound', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 400 }
    })
    await expect(
      (async () => {
        for (let index = 0; index < 50; index += 1) {
          await journal.appendItem(item(index), body('x'.repeat(64)), { fence: 1 })
        }
      })()
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('keeps the size bound across repeated compaction cycles', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 6_000 },
      compaction: { minTailRows: 1, retainTailMs: 0 }
    })
    let rejection: unknown
    for (let index = 0; index < 30; index += 1) {
      try {
        await journal.appendItem(item(index), body('x'.repeat(512)), { fence: 1 })
        await journal.compact(1)
      } catch (error) {
        rejection = error
        break
      }
    }
    expect(rejection).toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('refuses an append past the per-window rate bound', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxAppendsPerWindow: 3, appendWindowMs: 60_000 }
    })
    await expect(
      (async () => {
        for (let index = 0; index < 10; index += 1) {
          await journal.appendItem(item(index), body('x'), { fence: 1 })
        }
      })()
    ).rejects.toMatchObject({ code: 'journal_rate_exceeded' })
  })
})

describe('schema', () => {
  it('degrades to read-only on a row from a newer build, without skipping or deleting it', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    const future = JSON.stringify({
      v: 99,
      kind: 'item',
      epoch: journal.epoch,
      seq: 99,
      fence: 1,
      ts: 1,
      itemId: 'future',
      revision: 1,
      body: { kind: 'status', text: 'from a newer host' }
    })
    const before = await readFile(logPath, 'utf-8')
    await writeFile(logPath, `${before}${future}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(true)
    expect(reopened.snapshot().items).toEqual([])
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await expect(reopened.compact(1)).rejects.toMatchObject({ code: 'journal_read_only' })
    expect(reopened.readSince({ epoch: reopened.epoch, sequence: 0 })).toEqual({
      ok: false,
      reset: 'schema_unreadable'
    })
    // The unreadable row is still on disk, and nothing was compacted past it.
    expect(await readFile(logPath, 'utf-8')).toContain('"v":99')
  })

  it('degrades to read-only on a snapshot from a newer build without overwriting it', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.compact(1)
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    const future = JSON.stringify({ ...snapshot, v: 99, futureState: 'keep me' })
    await writeFile(snapshotPath, future, 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(true)
    expect(reopened.snapshot().items).toEqual([])
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await expect(reopened.compact(1)).rejects.toMatchObject({ code: 'journal_read_only' })
    expect(await readFile(snapshotPath, 'utf-8')).toBe(future)
  })

  it('skips a malformed line without giving up the journal', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}{not json\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(false)
    expect(reopened.snapshot().items).toHaveLength(1)
  })

  it('rolls the epoch instead of reusing a malformed row sequence', async () => {
    const journal = await open()
    const appended = await journal.appendItem(item(0), body('original'), { fence: 1 })
    const originalEpoch = journal.epoch
    const logPath = join(root, JOURNAL_LOG_FILE)
    const rows = (await readFile(logPath, 'utf-8')).trim().split('\n')
    const malformed = JSON.parse(rows[1]!) as Record<string, unknown>
    malformed.body = null
    rows[1] = JSON.stringify(malformed)
    await writeFile(logPath, `${rows.join('\n')}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.epoch).not.toBe(originalEpoch)
    expect(reopened.readSince(appended.cursor)).toEqual({ ok: false, reset: 'epoch_changed' })
  })

  it('separates the next append from a malformed non-newline tail', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}{"v":1`, 'utf-8')

    const reopened = await open()
    await reopened.appendItem(item(1), body('b'), { fence: 1 })

    const replayed = await open()
    expect(replayed.snapshot().items.map((entry) => entry.body)).toEqual([body('a'), body('b')])
    expect(replayed.cursor()).toEqual(reopened.cursor())
  })
})

describe('journal location', () => {
  it('keys by workspace and session id rather than by a path in the working tree', () => {
    const dir = journalDirectoryFor('/state', { workspaceId: 'ws/1', sessionId: 'sess:2' })
    expect(dir).toBe(
      join(
        '/state',
        'agent-session-journal',
        journalPathSegment('ws/1'),
        journalPathSegment('sess:2')
      )
    )
    expect(dir).not.toContain('ws/1')
  })

  it('separates two sessions in one workspace', () => {
    const a = journalDirectoryFor('/state', { workspaceId: 'ws', sessionId: 'a' })
    const b = journalDirectoryFor('/state', { workspaceId: 'ws', sessionId: 'b' })
    expect(a).not.toBe(b)
  })
})

describe('on-disk layout', () => {
  it('writes the log and snapshot beside each other', async () => {
    const journal: AgentSessionJournal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await expect(readFile(join(root, JOURNAL_LOG_FILE), 'utf-8')).resolves.toContain(
      '"kind":"item"'
    )
    await expect(readFile(join(root, JOURNAL_SNAPSHOT_FILE), 'utf-8')).resolves.toContain('"epoch"')
  })
})
