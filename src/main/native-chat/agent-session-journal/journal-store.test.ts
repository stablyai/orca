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
import { journalDirectoryBytes } from './journal-physical-quota'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import { AgentSessionJournalError, type AgentSessionJournal } from './journal-store'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  JOURNAL_DISPATCH_RESERVATION_BYTES,
  JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES,
  JOURNAL_TURN_TERMINAL_RESERVATION_BYTES
} from './journal-lifecycle-capacity'

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
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 }
    })
    // Shedding the whole tail still cannot make room, so the bound holds.
    await expect(
      journal.appendItem(item(0), body('x'.repeat(4_096)), { fence: 1 })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('refuses an append past the per-session size bound when compaction is off', async () => {
    const journal = await open({
      autoCompact: false,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 }
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

  it('charges unique blobs and abandoned staging files to one physical quota', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 8_000 }
    const journal = await open({ limits, autoCompact: false })
    const payload = 'z'.repeat(1_200)
    const bounded = boundPayload(payload, { ...limits, inlineHeadBytes: 8 })
    const toolBody: AgentJournalItemBody = {
      kind: 'tool-call',
      name: 'command',
      input: {},
      state: 'completed',
      output: bounded
    }

    await journal.appendItemWithBlobs(item(1), toolBody, [{ digest: bounded.digest, payload }], {
      fence: 1
    })
    const afterFirst = await journalDirectoryBytes(root)
    await journal.appendItemWithBlobs(item(2), toolBody, [{ digest: bounded.digest, payload }], {
      fence: 1
    })
    const afterDuplicate = await journalDirectoryBytes(root)

    expect(afterDuplicate - afterFirst).toBeLessThan(payload.length)
    expect(await readdir(join(root, 'blobs'))).toEqual([bounded.digest])
    expect(afterDuplicate).toBeLessThanOrEqual(limits.maxSessionBytes)

    await writeFile(join(root, 'log.jsonl.abandoned.tmp'), 's'.repeat(2_000), 'utf8')
    const physical = await journalDirectoryBytes(root)
    await expect(
      open({ limits: { ...limits, maxSessionBytes: physical - 1 } })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
  })

  it('uses a running tool reservation when its authoritative blob cannot fit', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 220 * 1024 }
    const journal = await open({ limits, autoCompact: false })
    await journal.appendItem(
      item(1),
      { kind: 'tool-call', name: 'command', input: {}, state: 'running' },
      { fence: 1 }
    )
    for (let ordinal = 10; ordinal < 100; ordinal += 1) {
      try {
        await journal.appendItem(item(ordinal), body('f'.repeat(4_000)), { fence: 1 })
      } catch (error) {
        expect(error).toMatchObject({ code: 'journal_bound_exceeded' })
        break
      }
    }
    const payload = 'o'.repeat(100 * 1024)
    const bounded = boundPayload(payload, { ...limits, inlineHeadBytes: 16 * 1024 })

    await journal.appendItemWithBlobs(
      item(1),
      {
        kind: 'tool-call',
        name: 'command',
        input: {},
        state: 'completed',
        output: bounded
      },
      [{ digest: bounded.digest, payload }],
      { fence: 1 }
    )

    const tool = journal.snapshot().items.find((entry) => entry.itemId.includes('turn-1:1'))
    expect(tool?.body).toEqual({
      kind: 'tool-call',
      name: 'command',
      input: {},
      state: 'completed'
    })
    expect(
      journal
        .snapshot()
        .items.some(
          (entry) =>
            entry.body.kind === 'status' && entry.body.text.includes('could not be retained')
        )
    ).toBe(true)
    expect(await readJournalBlob(root, bounded.digest)).toBeNull()
    expect(journal.lifecycleCapacityState()).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })

  it('keeps cached physical bytes aligned after blob dedupe and compaction', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 45_000 }
    const journal = await open({
      limits,
      autoCompact: false,
      compaction: { minTailRows: 0, retainTailMs: 0 }
    })
    const payload = 'p'.repeat(20_000)
    const bounded = boundPayload(payload, { ...limits, inlineHeadBytes: 8 })
    const toolBody: AgentJournalItemBody = {
      kind: 'tool-call',
      name: 'command',
      input: {},
      state: 'completed',
      output: bounded
    }

    await journal.appendItemWithBlobs(item(1), toolBody, [{ digest: bounded.digest, payload }], {
      fence: 1
    })
    await journal.appendItemWithBlobs(item(2), toolBody, [{ digest: bounded.digest, payload }], {
      fence: 1
    })
    await journal.compact(tick() + 10, { minTailRows: 0, retainTailMs: 0 })
    const compactedBytes = await journalDirectoryBytes(root)
    expect(compactedBytes).toBeLessThan(limits.maxSessionBytes)

    await journal.appendItem(item(3), body('after compaction'), { fence: 1 })

    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)
    expect(await readdir(join(root, 'blobs'))).toEqual([bounded.digest])
  })
})

describe('lifecycle batches', () => {
  it('uses a reserved append slot after ordinary rate pressure', async () => {
    const journal = await open({
      autoCompact: false,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxAppendsPerWindow: 1, appendWindowMs: 60_000 }
    })
    const identity: AgentJournalItemIdentity = {
      provider: 'orca',
      clientMessageId: 'reserved-prompt'
    }
    const pending: AgentJournalItemBody = {
      kind: 'approval',
      title: 'Run a command?',
      detail: null,
      options: [{ id: 'accept', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }

    // The pending row spends the only ordinary slot while reserving its
    // terminal append slot for recovery.
    await journal.appendLifecycleBatch({
      settlementId: 'reserved-start',
      fence: 1,
      mutations: [{ kind: 'item', identity, body: pending }]
    })
    await expect(
      journal.appendItem(
        identity,
        {
          ...pending,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'accept',
            resolvedBy: 'test',
            resolvedAt: 1
          }
        },
        { fence: 1 }
      )
    ).resolves.toBeDefined()
  })

  it('rate-limits an unreserved lifecycle batch', async () => {
    const journal = await open({
      autoCompact: false,
      limits: { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxAppendsPerWindow: 1, appendWindowMs: 60_000 }
    })
    const mutation = (id: string): JournalLifecycleMutationInput => ({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: id },
      body: { kind: 'status', text: 'provider diagnostic' }
    })
    await journal.appendLifecycleBatch({
      settlementId: 'unreserved-1',
      fence: 1,
      mutations: [mutation('one')]
    })
    await expect(
      journal.appendLifecycleBatch({
        settlementId: 'unreserved-2',
        fence: 1,
        mutations: [mutation('two')]
      })
    ).rejects.toMatchObject({ code: 'journal_rate_exceeded' })
  })

  it('rebuilds dispatch and turn reservations for pending submissions after reopen', async () => {
    const journal = await open({ autoCompact: false })
    await journal.appendSubmission({
      clientMessageId: 'pending-send',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: 1
    })

    const reopened = await open({ autoCompact: false })
    expect(reopened.lifecycleCapacityState()).toEqual({
      reservedBytes: JOURNAL_DISPATCH_RESERVATION_BYTES + JOURNAL_TURN_TERMINAL_RESERVATION_BYTES,
      reservedAppendSlots: 2
    })
  })

  it('deduplicates concurrent submissions before appending a second row', async () => {
    const journal = await open()
    const input = {
      settlementId: 'concurrent-settlement',
      fence: 1,
      mutations: [{ kind: 'item' as const, identity: item(1), body: body('settled') }]
    }

    const [first, replay] = await Promise.all([
      journal.appendLifecycleBatch(input),
      journal.appendLifecycleBatch(input)
    ])

    expect([replay, first.sequence]).toEqual([first, 2])
  })

  it('applies every mutation at one sequence and deduplicates a replay across reopen', async () => {
    const journal = await open({ autoCompact: false })
    const turn: AgentJournalItemIdentity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(turn, { kind: 'status', text: 'working' }, { fence: 1 })

    const settled = await journal.appendLifecycleBatch({
      settlementId: 'exit:turn-1',
      fence: 1,
      mutations: [
        { kind: 'item', identity: item(1), body: body('tool settled') },
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'exit-status' },
          body: { kind: 'status', text: 'Provider exited' }
        },
        { kind: 'tombstone', identity: turn }
      ]
    })
    const atSettlement = journal
      .snapshot()
      .items.filter((entry) => entry.sequence === settled.sequence)
    expect(atSettlement).toHaveLength(2)
    expect(
      journal
        .snapshot()
        .items.some((entry) => entry.body.kind === 'status' && entry.body.text === 'working')
    ).toBe(false)
    await journal.compact(tick() + 10, { minTailRows: 0, retainTailMs: 0 })

    const reopened = await open({ autoCompact: false })
    const beforeReplay = reopened.cursor()
    const replay = await reopened.appendLifecycleBatch({
      settlementId: 'exit:turn-1',
      fence: 1,
      mutations: [{ kind: 'item', identity: item(9), body: body('must not appear') }]
    })
    expect(replay).toEqual(beforeReplay)
    expect(
      reopened
        .snapshot()
        .items.some(
          (entry) =>
            entry.body.kind === 'message' &&
            entry.body.blocks.some(
              (block) => block.type === 'text' && block.text === 'must not appear'
            )
        )
    ).toBe(false)
  })

  it('reserves and releases terminal prompts created inside lifecycle batches', async () => {
    const journal = await open()
    const identity: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'prompt-1' }
    const pending: AgentJournalItemBody = {
      kind: 'approval',
      title: 'Run a command?',
      detail: null,
      options: [{ id: 'accept', label: 'Allow' }],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }

    await journal.appendLifecycleBatch({
      settlementId: 'prompt-start',
      fence: 1,
      mutations: [{ kind: 'item', identity, body: pending }]
    })

    expect(journal.lifecycleCapacityState()).toEqual({
      reservedBytes: JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES,
      reservedAppendSlots: 1
    })

    await journal.appendItem(
      identity,
      {
        ...pending,
        resolution: {
          state: 'resolved',
          selectedOptionId: 'accept',
          resolvedBy: 'test',
          resolvedAt: tick()
        }
      },
      { fence: 1 }
    )

    expect(journal.lifecycleCapacityState()).toEqual({
      reservedBytes: 0,
      reservedAppendSlots: 0
    })
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
