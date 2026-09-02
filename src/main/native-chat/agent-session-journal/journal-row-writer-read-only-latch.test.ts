import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { readJournalBlob } from './journal-blob-store'
import { appendJournalRows } from './journal-log-file'
import { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import { JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES } from './journal-lifecycle-capacity'
import { loadJournal } from './journal-open'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalAppendBudget } from './journal-write-guards'

const SESSION_ID = 'session-1'

function row(seq: number, ts: number): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: 'item-1',
    revision: 1,
    body: { kind: 'status', text: 'ambiguous append' }
  }
}

function rowWithBlob(seq: number, ts: number, output: ReturnType<typeof boundPayload>): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: 'item-with-blob',
    revision: 1,
    body: {
      kind: 'tool-call',
      name: 'shell',
      input: {},
      state: 'completed',
      output
    }
  }
}

function runningToolRow(seq: number, ts: number, itemId = 'running-tool'): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId,
    revision: 1,
    body: runningToolBody()
  }
}

function runningToolBody(): AgentJournalItemBody {
  return { kind: 'tool-call', name: 'shell', input: {}, state: 'running' }
}

describe('journal row writer read-only latch', () => {
  let root: string
  let readOnly = false

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-row-writer-'))
    readOnly = false
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('enforces the lifecycle append rate and allows a retry after the window', () => {
    const appendWindowMs = 100
    const budget = new JournalAppendBudget(SESSION_ID, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxAppendsPerWindow: 1,
      appendWindowMs
    })

    budget.assertLifecycle(row(1, 1), 0)
    expect(() => budget.assertLifecycle(row(2, 1), 0)).toThrow(
      expect.objectContaining({ code: 'journal_rate_exceeded' })
    )
    expect(() => budget.assertLifecycle(row(2, appendWindowMs + 1), 0)).not.toThrow()
  })

  it('refuses lifecycle reservations once aggregate append capacity is saturated', () => {
    const admission = new JournalLifecycleAdmission(SESSION_ID, 1_000_000, (itemId) => itemId, 2)
    expect(admission.reserve({ id: 'first', bytes: 1, appendSlots: 1 }, 0)).toBe(true)
    expect(admission.reserve({ id: 'second', bytes: 1, appendSlots: 1 }, 0)).toBe(true)
    expect(admission.reserve({ id: 'third', bytes: 1, appendSlots: 1 }, 0)).toBe(false)
  })

  function writerHarness(
    overrides: {
      limits?: typeof DEFAULT_JOURNAL_PAYLOAD_LIMITS
      physicalBytes?: number
      appendRows?: (journalDir: string, rows: readonly JournalRow[]) => Promise<void>
      commit?: (row: JournalRow, physicalBytes: number) => void
    } = {}
  ) {
    const limits = overrides.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    const lifecycleAdmission = new JournalLifecycleAdmission(
      SESSION_ID,
      limits.maxSessionBytes,
      (itemId) => itemId
    )
    let physicalBytes = overrides.physicalBytes ?? 0
    let nextSequence = 1
    const committedRows: JournalRow[] = []
    const writer = new JournalRowWriter({
      journalDir: root,
      sessionId: SESSION_ID,
      budget: new JournalAppendBudget(SESSION_ID, limits),
      lifecycleAdmission,
      autoCompact: false,
      compaction: { minTailRows: 0, retainTailMs: 0 },
      now: () => 1,
      serialize: (run) => run(),
      readOnly: () => readOnly,
      setReadOnly: (value) => {
        readOnly = value
      },
      physicalBytes: () => physicalBytes,
      highestFence: () => 0,
      nextSequence: () => nextSequence,
      tailRows: () => committedRows,
      referencedBlobDigests: () => new Set(),
      compact: async () => undefined,
      commit: (row, nextPhysicalBytes) => {
        overrides.commit?.(row, nextPhysicalBytes)
        committedRows.push(row)
        physicalBytes = nextPhysicalBytes
        nextSequence = row.seq + 1
      },
      ...(overrides.appendRows ? { appendRows: overrides.appendRows } : {})
    })
    return { writer, lifecycleAdmission, committedRows }
  }

  it('latches read-only when a post-append failure makes durability ambiguous', async () => {
    let committed = false
    const writer = new JournalRowWriter({
      journalDir: root,
      sessionId: 'session-1',
      budget: new JournalAppendBudget('session-1', DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      lifecycleAdmission: new JournalLifecycleAdmission(
        'session-1',
        DEFAULT_JOURNAL_PAYLOAD_LIMITS.maxSessionBytes,
        (itemId) => itemId
      ),
      autoCompact: false,
      compaction: { minTailRows: 0, retainTailMs: 0 },
      now: () => 1,
      serialize: (run) => run(),
      readOnly: () => readOnly,
      setReadOnly: (value) => {
        readOnly = value
      },
      physicalBytes: () => 0,
      highestFence: () => 0,
      nextSequence: () => 1,
      tailRows: () => [],
      referencedBlobDigests: () => new Set(),
      compact: async () => undefined,
      commit: () => {
        committed = true
      },
      appendRows: async (journalDir, rows) => {
        await appendJournalRows(journalDir, rows)
        throw new Error('fsync failed after append')
      }
    })

    await expect(writer.enqueue(row)).rejects.toThrow('fsync failed after append')

    expect(readOnly).toBe(true)
    expect(committed).toBe(false)
    await expect(writer.enqueue(row)).rejects.toMatchObject({ code: 'journal_read_only' })
  })

  it('keeps blobs for a durable row when a post-append crash is reported', async () => {
    const payload = 'durable blob payload'.repeat(2_000)
    const bounded = boundPayload(payload, {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      inlineHeadBytes: 32
    })
    const writer = new JournalRowWriter({
      journalDir: root,
      sessionId: 'session-1',
      budget: new JournalAppendBudget('session-1', DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      lifecycleAdmission: new JournalLifecycleAdmission(
        'session-1',
        DEFAULT_JOURNAL_PAYLOAD_LIMITS.maxSessionBytes,
        (itemId) => itemId
      ),
      autoCompact: false,
      compaction: { minTailRows: 0, retainTailMs: 0 },
      now: () => 1,
      serialize: (run) => run(),
      readOnly: () => readOnly,
      setReadOnly: (value) => {
        readOnly = value
      },
      physicalBytes: () => 0,
      highestFence: () => 0,
      nextSequence: () => 1,
      tailRows: () => [],
      referencedBlobDigests: () => new Set(),
      compact: async () => undefined,
      commit: () => undefined,
      appendRows: async (journalDir, rows) => {
        await appendJournalRows(journalDir, rows)
        throw new Error('crash after row append')
      }
    })

    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).rejects.toThrow('crash after row append')

    expect(readOnly).toBe(true)
    await expect(writer.enqueue(row)).rejects.toMatchObject({ code: 'journal_read_only' })
    expect(await readJournalBlob(root, bounded.digest)).toBe(payload)
    const reopened = await loadJournal(root, 'session-1')
    const item = reopened?.state.items.get('item-with-blob')
    expect(item?.body).toMatchObject({
      kind: 'tool-call',
      output: { digest: bounded.digest, truncated: true }
    })
  })

  it('does not leak a lifecycle reservation after budget refusal', async () => {
    const probe = runningToolRow(1, 1)
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxSessionBytes: JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES + journalRowByteLength(probe) - 1
    }
    const { writer, lifecycleAdmission, committedRows } = writerHarness({ limits })

    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
    await expect(writer.enqueue(row)).resolves.toMatchObject({ kind: 'item', itemId: 'item-1' })
    expect(
      committedRows.map((entry) => (entry.kind === 'item' ? entry.itemId : 'non-item'))
    ).toEqual(['item-1'])
  })

  it('preflights existing durable-write temps before creating a blob or row', async () => {
    const tempBytes = 512
    const tempPath = join(root, 'log.jsonl.existing-write.tmp')
    await writeFile(tempPath, 't'.repeat(tempBytes), 'utf8')
    const probe = row(1, 1)
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxSessionBytes: tempBytes + journalRowByteLength(probe) - 1
    }
    const { writer, committedRows } = writerHarness({ limits })

    await expect(writer.enqueue((seq, ts) => row(seq, ts))).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })
    expect(committedRows).toHaveLength(0)
    expect(await readJournalBlob(root, 'a'.repeat(64))).toBeNull()
  })

  it('does not leak a lifecycle reservation after blob lookup failure', async () => {
    const { writer, lifecycleAdmission } = writerHarness()
    const digest = 'a'.repeat(64)
    await writeFile(join(root, 'blobs'), 'not a directory', 'utf8')

    await expect(
      writer.enqueue((seq, ts) => runningToolRow(seq, ts), [{ digest, payload: 'payload' }])
    ).rejects.toThrow()

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
    await rm(join(root, 'blobs'), { force: true })
    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).resolves.toMatchObject({
      kind: 'item',
      itemId: 'running-tool'
    })
    expect(lifecycleAdmission.state).toEqual({
      reservedBytes: JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES,
      reservedAppendSlots: 1
    })
  })

  it('rolls back ordinary append-rate reservation after blob preflight failure', async () => {
    const limits = {
      ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
      maxAppendsPerWindow: 1,
      appendWindowMs: 100
    }
    const { writer, committedRows } = writerHarness({ limits })
    const payload = 'retryable blob payload'.repeat(100)
    const bounded = boundPayload(payload, limits)
    await writeFile(join(root, 'blobs'), 'not a directory', 'utf8')

    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).rejects.toThrow()

    await rm(join(root, 'blobs'), { force: true })
    await expect(
      writer.enqueue(
        (seq, ts) => rowWithBlob(seq, ts, bounded),
        [{ digest: bounded.digest, payload }]
      )
    ).resolves.toMatchObject({ kind: 'item', itemId: 'item-with-blob' })
    expect(committedRows).toHaveLength(1)
  })

  it('does not leak a lifecycle reservation after durable append failure', async () => {
    const { writer, lifecycleAdmission } = writerHarness({
      appendRows: async () => {
        throw new Error('append failed before a durable row existed')
      }
    })

    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).rejects.toThrow(
      'append failed before a durable row existed'
    )

    expect(readOnly).toBe(true)
    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })

  it('does not leak a lifecycle reservation after reducer commit failure', async () => {
    const { writer, lifecycleAdmission } = writerHarness({
      commit: () => {
        throw new Error('commit failed after durable append')
      }
    })

    await expect(writer.enqueue((seq, ts) => runningToolRow(seq, ts))).rejects.toThrow(
      'commit failed after durable append'
    )

    expect(lifecycleAdmission.state).toEqual({ reservedBytes: 0, reservedAppendSlots: 0 })
  })
})
