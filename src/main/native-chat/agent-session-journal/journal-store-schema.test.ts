import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE } from './journal-log-file'
import { openAgentSessionJournal } from './journal-store-factory'

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
