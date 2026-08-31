import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  boundJournalKeyComponent,
  MAX_JOURNAL_KEY_COMPONENT_CHARS
} from '../../../shared/agent-session-journal-item-key'
import { readJournalBlob } from './journal-blob-store'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE } from './journal-log-file'
import { loadJournal } from './journal-open'
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

  it('preserves an oversized identity and its raw digest-form mimic across reopen', async () => {
    const oversizedTurnId = 'a'.repeat(MAX_JOURNAL_KEY_COMPONENT_CHARS + 1)
    const digestFormMimic = boundJournalKeyComponent(oversizedTurnId)
    const identityFor = (turnId: string): AgentJournalItemIdentity => ({
      provider: 'codex',
      threadId: 'thread-1',
      turnId,
      ordinal: 0
    })
    const oversizedIdentity = identityFor(oversizedTurnId)
    const mimicIdentity = identityFor(digestFormMimic)
    const journal = await open()

    const oversized = await journal.appendItem(oversizedIdentity, body('oversized'), { fence: 1 })
    const mimic = await journal.appendItem(mimicIdentity, body('mimic'), { fence: 1 })
    expect(oversized.itemId).not.toBe(mimic.itemId)
    expect([oversized.revision, mimic.revision]).toEqual([1, 1])

    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('oversized'),
      body('mimic')
    ])

    await reopened.appendTombstone(oversizedIdentity, { fence: 1 })
    const afterTombstoneReopen = await open()
    expect(afterTombstoneReopen.snapshot().items.map((entry) => entry.body)).toEqual([
      body('mimic')
    ])
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
})

describe('replay', () => {
  it('adopts a caller-provided load without reading the journal files again', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const loaded = await loadJournal(root, IDENTITY.sessionId)
    expect(loaded).not.toBeNull()

    await rm(join(root, JOURNAL_LOG_FILE), { force: true })
    await rm(join(root, JOURNAL_SNAPSHOT_FILE), { force: true })

    const reopened = await open({ loaded })
    expect(reopened.snapshot()).toEqual(journal.snapshot())
  })

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

  it('preserves the intact prefix and quarantines a corrupt suffix', async () => {
    const journal = await open()
    for (let index = 0; index < 4; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const before = journal.epoch
    const logPath = join(root, JOURNAL_LOG_FILE)
    const lines = (await readFile(logPath, 'utf-8')).split('\n').filter(Boolean)
    await writeFile(logPath, `${[...lines.slice(0, 2), ...lines.slice(3)].join('\n')}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.epoch).toBe(before)
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('m0')])
    const files = await readdir(root)
    expect(files.some((name) => name.startsWith('quarantine-'))).toBe(true)
  })
})

describe('automatic compaction', () => {
  // Production passes no policy and never called compact(), so the log only
  // ever grew — until the size bound refused every append for good.
  it('compacts on append once the retention window has rows to shed', async () => {
    const policy = { minTailRows: 2, retainTailMs: 0 }
    const journal = await open({ compaction: policy })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    expect(journal.compactionBoundary).toBeGreaterThan(0)
    // The log sheds instead of growing with every append (7 = epoch row + 6).
    const log = await readFile(join(root, JOURNAL_LOG_FILE), 'utf-8')
    expect(log.trim().split('\n').length).toBeLessThan(7)
    // Nothing is lost: the folded prefix is served from the snapshot.
    expect(journal.snapshot().items).toHaveLength(6)
  })

  it('does not rewrite the log while every row is inside the retention window', async () => {
    const journal = await open({ compaction: { minTailRows: 2, retainTailMs: 60_000 } })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    expect(journal.compactionBoundary).toBe(0)
  })

  it('can be turned off explicitly', async () => {
    const journal = await open({
      autoCompact: false,
      compaction: { minTailRows: 2, retainTailMs: 0 }
    })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    expect(journal.compactionBoundary).toBe(0)
  })

  it('refuses an append when a tail shorter than the row floor cannot make room', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 900 },
      // The tail never reaches the floor, so honouring it would shed nothing.
      compaction: { minTailRows: 512, retainTailMs: 10_000 }
    })
    let rejected = 0
    for (let index = 0; index < 20; index += 1) {
      try {
        await journal.appendItem(item(index), body('x'.repeat(96)), { fence: 1 })
      } catch (error) {
        expect(error).toMatchObject({ code: 'journal_bound_exceeded' })
        rejected += 1
      }
    }
    expect(rejected).toBeGreaterThan(0)
  })

  it('refuses once the retained snapshot itself reaches the session bound', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 10_000 },
      compaction: { minTailRows: 10, retainTailMs: 2 * 60 * 60 * 1000 }
    })
    let rejected = 0
    for (let index = 0; index < 30; index += 1) {
      try {
        await journal.appendItem(item(index), body('x'.repeat(128)), { fence: 1 })
      } catch (error) {
        expect(error).toMatchObject({ code: 'journal_bound_exceeded' })
        rejected += 1
      }
    }

    expect(rejected).toBeGreaterThan(0)
    expect(journal.snapshot().items.length).toBeLessThan(30)
  })

  it('keeps the newest rows resumable while shedding under budget pressure', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 10_000 },
      compaction: { minTailRows: 10, retainTailMs: 2 * 60 * 60 * 1000 }
    })
    for (let index = 0; index < 30; index += 1) {
      await journal.appendItem(item(index), body('x'.repeat(64)), { fence: 1 })
    }

    // The window yields oldest-first, never wholesale: the latest append is
    // still in the log, so a client resuming from it does not reload.
    const log = (await readFile(join(root, JOURNAL_LOG_FILE), 'utf-8')).trim().split('\n')
    expect(log.length).toBeGreaterThan(0)
    expect(log.at(-1)).toContain('"seq"')
  })
})

describe('compaction and retention', () => {
  it('preserves the highest fence across compaction and reopen', async () => {
    const journal = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await journal.appendItem(item(0), body('a'), { fence: 7 })
    await journal.compact()
    const reopened = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await expect(reopened.appendItem(item(1), body('stale'), { fence: 6 })).rejects.toMatchObject({
      code: 'journal_stale_fence'
    })
  })

  it('preserves tombstones across compaction and reopen', async () => {
    const journal = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.appendTombstone(item(0), { fence: 1 })
    await journal.compact()
    const reopened = await open({ compaction: { minTailRows: 1, retainTailMs: 0 } })
    await reopened.appendItem(item(0), body('stale'), { fence: 1 })
    expect(reopened.snapshot().items).toHaveLength(0)
  })

  it('folds the prefix into the snapshot and keeps serving the retained tail', async () => {
    const journal = await open({ compaction: { minTailRows: 2, retainTailMs: 0 } })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    const rendered = journal.snapshot()
    const tip = journal.cursor()
    await journal.compact()

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
    await journal.compact()
    const persistedSnapshot = JSON.parse(
      await readFile(join(root, JOURNAL_SNAPSHOT_FILE), 'utf-8')
    ) as { tail: unknown[] }
    expect(persistedSnapshot.tail).toHaveLength(2)
    // Simulate the crash: the snapshot landed, the truncation did not.
    await writeFile(join(root, JOURNAL_LOG_FILE), logBefore, 'utf-8')

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(rendered)
    expect(reopened.snapshot().items).toHaveLength(5)
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
    await journal.compact()

    expect(await readJournalBlob(root, kept.digest)).toBe('k'.repeat(64))
    expect(await readJournalBlob(root, dropped.digest)).toBeNull()
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

  it('refuses a single row larger than the per-session size bound', async () => {
    const journal = await open({
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 400 }
    })
    // Shedding the whole tail still cannot make room, so the bound holds.
    await expect(
      journal.appendItem(item(0), body('x'.repeat(4_096)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('refuses an append past the per-session size bound when compaction is off', async () => {
    const journal = await open({
      autoCompact: false,
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
  it('quarantines an invalid compacted snapshot without replacing its tail', async () => {
    const journal = await open({ compaction: { minTailRows: 2, retainTailMs: 0 } })
    for (let index = 0; index < 6; index += 1) {
      await journal.appendItem(item(index), body(`m${index}`), { fence: 1 })
    }
    await journal.compact()
    const epoch = journal.epoch
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const logPath = join(root, JOURNAL_LOG_FILE)
    const invalidSnapshot = '{"folded history":'
    await writeFile(snapshotPath, invalidSnapshot, 'utf-8')
    const retainedTail = await readFile(logPath, 'utf-8')
    expect(retainedTail).not.toContain('"kind":"epoch"')

    const reopened = await open()
    expect(reopened.epoch).toBe(epoch)
    expect(await readFile(logPath, 'utf-8')).toBe(retainedTail)
    const quarantined = (await readdir(root)).find((name) =>
      name.startsWith('quarantine-snapshot-')
    )
    expect(quarantined).toBeDefined()
    expect(await readFile(join(root, quarantined!), 'utf-8')).toBe(invalidSnapshot)
  })

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
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await expect(reopened.compact()).rejects.toMatchObject({ code: 'journal_read_only' })
    expect(reopened.readSince({ epoch: reopened.epoch, sequence: 0 })).toEqual({
      ok: false,
      reset: 'schema_unreadable'
    })
    // The unreadable row is still on disk, and nothing was compacted past it.
    expect(await readFile(logPath, 'utf-8')).toContain('"v":99')
  })

  it('skips a malformed line without giving up the journal, and discloses the skip', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}{not json\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(false)
    const items = reopened.snapshot().items
    // The surviving row is untouched…
    expect(items.some((entry) => entry.body.kind === 'message')).toBe(true)
    // …and the skip is visible in the timeline instead of silently swallowed.
    expect(
      items.some(
        (entry) => entry.body.kind === 'status' && entry.body.text.includes('could not be read')
      )
    ).toBe(true)
  })

  it('keeps one disclosure row across reopens instead of stacking duplicates', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}{not json\n`, 'utf-8')

    await open()
    const reopened = await open()
    expect(
      reopened
        .snapshot()
        .items.filter(
          (entry) => entry.body.kind === 'status' && entry.body.text.includes('could not be read')
        )
    ).toHaveLength(1)
  })

  it('repairs a torn tail before acknowledging the next append', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    const intact = await readFile(logPath, 'utf-8')
    await writeFile(logPath, intact.slice(0, -1), 'utf-8')

    await journal.appendItem(item(1), body('b'), { fence: 1 })
    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([body('a'), body('b')])
  })

  // Transcripts are full of emoji and CJK, so the repair's file offsets must be
  // bytes: string indices would truncate mid-character and corrupt the prefix.
  it('repairs a torn tail whose rows contain multi-byte characters', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('안녕하세요 🌊 café'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    const intact = await readFile(logPath)
    // Kill mid-row: keep the complete first row plus a fragment of the second.
    const torn = Buffer.concat([intact, Buffer.from('{"seq":2,"kind":"it', 'utf-8')])
    await writeFile(logPath, torn)

    await journal.appendItem(item(1), body('b'), { fence: 1 })
    const reopened = await open()
    expect(reopened.snapshot().items.map((entry) => entry.body)).toEqual([
      body('안녕하세요 🌊 café'),
      body('b')
    ])
  })

  it('degrades to read-only when the snapshot comes from a newer schema', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    snapshot.v = 99
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(true)
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
  })

  it('preserves a future-version snapshot with an unknown body kind in place instead of quarantining it', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    snapshot.v = 99
    // The version advances because bodies changed: a valid newer snapshot
    // carries kinds this build cannot parse and must stay unreadable in place.
    snapshot.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'future-render-kind', payload: { anything: true } },
        sequence: 1,
        observedAt: 1_000
      }
    ]
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')

    const reopened = await open()
    const entries = await readdir(root)
    expect(entries.some((name) => name.startsWith('quarantine-'))).toBe(false)
    expect(entries.includes(JOURNAL_SNAPSHOT_FILE)).toBe(true)
    expect(reopened.isReadOnly).toBe(true)
    expect(reopened.snapshot().items).toHaveLength(0)
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
  })

  it('keeps the future-version snapshot bytes when the schema escape hatch rolls the epoch', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    snapshot.v = 99
    snapshot.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'future-render-kind', payload: { anything: true } },
        sequence: 1,
        observedAt: 1_000
      }
    ]
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')
    const reopened = await open()
    // Still live in place before the explicit escape hatch runs.
    expect((await readdir(root)).some((name) => name.startsWith('quarantine-'))).toBe(false)

    await reopened.rollEpoch('schema_unreadable', 2)
    expect(reopened.isReadOnly).toBe(false)
    const quarantine = (await readdir(root)).find((name) => name.startsWith('quarantine-'))
    expect(quarantine).toBeDefined()
    expect(await readFile(join(root, quarantine!), 'utf-8')).toContain('future-render-kind')
  })

  it('reopens a log holding an admitted malformed-percent item id without throwing', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    // `parseJournalRow` admits any string itemId, so replay must degrade a
    // malformed percent key to an opaque id instead of throwing URIError.
    const malformedKeyRow = JSON.stringify({
      v: 1,
      epoch: journal.epoch,
      seq: journal.cursor().sequence + 1,
      fence: 1,
      ts: 1,
      kind: 'item',
      itemId: '%',
      revision: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
    })
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}${malformedKeyRow}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(false)
    expect(reopened.snapshot().items.some((entry) => entry.itemId === '%')).toBe(true)
  })

  it('allows the explicit schema-unreadable epoch escape hatch while preserving the old files', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    snapshot.v = 99
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')
    const reopened = await open()

    await reopened.rollEpoch('schema_unreadable', 2)
    expect(reopened.isReadOnly).toBe(false)
    expect(reopened.snapshot().items).toHaveLength(0)
    expect((await readdir(root)).some((name) => name.startsWith('quarantine-'))).toBe(true)
  })

  it('keeps the unreadable log suffix in the schema escape quarantine', async () => {
    const journal = await open()
    const logPath = join(root, JOURNAL_LOG_FILE)
    const future = JSON.stringify({
      v: 99,
      kind: 'item',
      epoch: journal.epoch,
      seq: 2,
      fence: 1,
      ts: 1,
      itemId: 'future',
      revision: 1,
      body: { kind: 'status', text: 'preserve these bytes' }
    })
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}${future}\n`, 'utf-8')
    const reopened = await open()

    await reopened.rollEpoch('schema_unreadable', 2)
    const quarantine = (await readdir(root)).find((name) => name.startsWith('quarantine-'))
    expect(quarantine).toBeDefined()
    expect(await readFile(join(root, quarantine!), 'utf-8')).toContain('preserve these bytes')
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
