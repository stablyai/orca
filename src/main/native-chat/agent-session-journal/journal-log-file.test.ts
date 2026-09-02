import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendJournalRows, JOURNAL_SNAPSHOT_FILE, readJournalSnapshot } from './journal-log-file'
import type { JournalSnapshotFile } from './journal-log-file'
import type { JournalRow } from './journal-row-schema'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  projectStructuredAgentSessionStatus,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'

type FakeDirectoryHandle = { sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }

let openDirectoryHook: ((path: unknown, flags: unknown) => FakeDirectoryHandle | undefined) | null =
  null

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const fake = openDirectoryHook?.(args[0], args[1])
      return fake ?? actual.open(...args)
    }) as typeof actual.open
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-log-file-'))
  openDirectoryHook = null
})

afterEach(async () => {
  openDirectoryHook = null
  await rm(root, { recursive: true, force: true })
})

function validSnapshot(): JournalSnapshotFile {
  return {
    v: 1,
    epoch: 'epoch-A',
    compactedThrough: 2,
    highestFence: 1,
    items: [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] },
        sequence: 2,
        observedAt: 1_000
      }
    ],
    submissions: [],
    receipts: [],
    aliases: [],
    tombstones: [{ itemId: 'codex:thread-1:turn-1:2', revision: 3 }],
    tail: []
  }
}

async function writeSnapshot(snapshot: unknown): Promise<void> {
  await writeFile(join(root, JOURNAL_SNAPSHOT_FILE), JSON.stringify(snapshot), 'utf-8')
}

describe('readJournalSnapshot validation', () => {
  it('accepts a well-formed snapshot, with and without the tombstones collection', async () => {
    await writeSnapshot(validSnapshot())
    expect((await readJournalSnapshot(root)).status).toBe('valid')

    const { tombstones: _tombstones, ...withoutTombstones } = validSnapshot()
    await writeSnapshot(withoutTombstones)
    expect((await readJournalSnapshot(root)).status).toBe('valid')
  })

  it('accepts every canonical item kind and a fully-formed submission', async () => {
    const snapshot = validSnapshot()
    const payload = { head: 'x', byteLength: 4, digest: 'd'.repeat(64), truncated: true }
    snapshot.items = [
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      {
        kind: 'tool-call',
        name: 'Read',
        input: { path: 'a' },
        state: 'completed',
        output: payload
      },
      { kind: 'diff', path: 'a.ts', patch: payload },
      {
        kind: 'approval',
        title: 'Run?',
        detail: null,
        options: [{ id: 'a', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      {
        kind: 'question',
        question: 'Deploy?',
        options: [{ id: 'a', label: 'Yes' }],
        freeTextQuestionId: 'q-free',
        resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 5 }
      },
      {
        kind: 'status',
        text: 'working',
        turnLifecycle: { turnId: 'turn-1', state: 'running' },
        providerFrame: { provider: 'codex', kind: 'raw', payload }
      }
    ].map((body, index) => ({
      itemId: `codex:thread-1:turn-1:${index + 1}`,
      revision: 1,
      body: body as JournalSnapshotFile['items'][number]['body'],
      sequence: index + 1,
      observedAt: 1_000,
      ...(index === 0 ? { recovered: true as const } : {})
    }))
    snapshot.compactedThrough = snapshot.items.length
    snapshot.submissions = [
      {
        clientMessageId: 'm-1',
        fence: 1,
        payloadFingerprint: 'a'.repeat(64),
        dispatchState: 'accepted',
        providerItemId: 'codex:thread-1:turn-1:1',
        reason: null,
        submittedAt: 1_000,
        resolvedAt: 1_001
      }
    ]
    await writeSnapshot(snapshot)
    expect((await readJournalSnapshot(root)).status).toBe('valid')
  })

  it('classifies a JSON-valid non-array tombstones collection as invalid instead of valid', async () => {
    await writeSnapshot({ ...validSnapshot(), tombstones: {} })
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })

  it('rejects tombstone entries that would poison seeding', async () => {
    for (const tombstones of [
      [{ itemId: 42, revision: 1 }],
      [{ itemId: 'codex:thread-1:turn-1:1', revision: 'one' }],
      [{ itemId: 'codex:thread-1:turn-1:1', revision: Number.NaN }],
      ['codex:thread-1:turn-1:1']
    ]) {
      await writeSnapshot({ ...validSnapshot(), tombstones })
      expect((await readJournalSnapshot(root)).status).toBe('invalid')
    }
  })

  it('rejects JSON-valid nested item corruption instead of admitting it', async () => {
    // A resolved question with `options: null` used to pass shallow admission and
    // then throw `TypeError` in the shared projection's `options.map`.
    const poisonedQuestion = validSnapshot()
    poisonedQuestion.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: {
          kind: 'question',
          question: 'Deploy?',
          options: null,
          resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 1 }
        },
        sequence: 2,
        observedAt: 1_000
      }
    ] as unknown as JournalSnapshotFile['items']
    await writeSnapshot(poisonedQuestion)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')

    // Pending-prompt surfaces read `resolution.state` before anything else.
    const nullResolution = validSnapshot()
    nullResolution.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'question', question: 'Deploy?', options: [], resolution: null },
        sequence: 2,
        observedAt: 1_000
      }
    ] as unknown as JournalSnapshotFile['items']
    await writeSnapshot(nullResolution)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })

  it('rejects a JSON-valid nested corruption in the retained tail', async () => {
    const poisonedTail = validSnapshot()
    poisonedTail.tail = [
      {
        v: 1,
        epoch: 'epoch-A',
        seq: 3,
        fence: 1,
        ts: 1_000,
        kind: 'item',
        itemId: 'codex:thread-1:turn-1:3',
        revision: 1,
        body: {
          kind: 'question',
          question: 'Deploy?',
          options: null,
          resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 1 }
        }
      }
    ] as unknown as JournalSnapshotFile['tail']
    await writeSnapshot(poisonedTail)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })

  it('rejects a submission that only carries a client message id', async () => {
    const shallowSubmission = validSnapshot()
    shallowSubmission.submissions = [
      { clientMessageId: 'm-1' }
    ] as unknown as JournalSnapshotFile['submissions']
    await writeSnapshot(shallowSubmission)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })

  it('rejects items and counters that only look shallowly plausible', async () => {
    const missingSequence = validSnapshot()
    missingSequence.items = [
      { itemId: 'codex:thread-1:turn-1:1', revision: 1, body: { kind: 'status', text: 'x' } }
    ] as unknown as JournalSnapshotFile['items']
    await writeSnapshot(missingSequence)
    expect((await readJournalSnapshot(root)).status).toBe('invalid')

    await writeSnapshot({ ...validSnapshot(), compactedThrough: Number.NaN })
    expect((await readJournalSnapshot(root)).status).toBe('invalid')
  })
})

describe('future-version snapshot classification', () => {
  it('classifies a future version before shape validation so unknown bodies stay unreadable', async () => {
    // The version can only advance because bodies changed, so a future snapshot
    // legitimately carries kinds this build cannot parse. That is the
    // schema-unreadable contract, not corruption.
    const future = validSnapshot() as unknown as Record<string, unknown>
    future.v = 99
    future.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: { kind: 'future-render-kind', payload: { anything: true } },
        sequence: 2,
        observedAt: 1_000
      }
    ]
    await writeSnapshot(future)
    expect((await readJournalSnapshot(root)).status).toBe('unreadable')
  })

  it('classifies a future version as unreadable even when its shapes still parse today', async () => {
    await writeSnapshot({ ...validSnapshot(), v: 99 })
    expect((await readJournalSnapshot(root)).status).toBe('unreadable')
  })

  it('treats a non-integer or sub-1 version as invalid, matching row admission', async () => {
    for (const v of [0, 1.5]) {
      await writeSnapshot({ ...validSnapshot(), v })
      expect((await readJournalSnapshot(root)).status).toBe('invalid')
    }
  })
})

describe('journal startup isolation from a malformed snapshot', () => {
  it('quarantines a JSON-valid malformed snapshot instead of throwing through open', async () => {
    await writeSnapshot({ ...validSnapshot(), tombstones: {} })

    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root
    })

    // Degraded exactly like other corrupt snapshots: quarantined on disk, never
    // silently deleted, and the session does not adopt state it cannot trust.
    const entries = await readdir(root)
    expect(entries.some((entry) => entry.startsWith('quarantine-snapshot-'))).toBe(true)
    expect(entries.includes(JOURNAL_SNAPSHOT_FILE)).toBe(false)
    expect(journal.snapshot().items).toEqual([])
  })
})

describe('reopen after a persisted JSON-valid poisoned question', () => {
  it('quarantines the snapshot so reopen-to-render cannot throw in projection', async () => {
    const poisoned = validSnapshot()
    poisoned.items = [
      {
        itemId: 'codex:thread-1:turn-1:1',
        revision: 1,
        body: {
          kind: 'question',
          question: 'Deploy?',
          options: null,
          resolution: { state: 'resolved', selectedOptionId: 'a', resolvedBy: 'c', resolvedAt: 1 }
        },
        sequence: 2,
        observedAt: 1_000
      }
    ] as unknown as JournalSnapshotFile['items']
    await writeSnapshot(poisoned)

    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root
    })

    // The poisoned item must land in quarantine, not in the reopened state:
    // pre-fix it was admitted and the render path below threw
    // `TypeError: Cannot read properties of null (reading 'map')`.
    const entries = await readdir(root)
    expect(entries.some((entry) => entry.startsWith('quarantine-snapshot-'))).toBe(true)
    const items = journal.snapshot().items
    expect(() => projectStructuredItemsToNativeChat(items)).not.toThrow()
    expect(() => projectStructuredAgentSessionStatus(items)).not.toThrow()
    expect(items).toEqual([])
  })
})

describe('appendJournalRows directory fsync', () => {
  const ROW: JournalRow = {
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    v: 1,
    epoch: 'epoch-A',
    seq: 1,
    fence: 0,
    ts: 1_000
  }

  function hookDirectoryOpen(sync: ReturnType<typeof vi.fn>): FakeDirectoryHandle {
    const fake: FakeDirectoryHandle = { sync, close: vi.fn(async () => undefined) }
    openDirectoryHook = (path, flags) => (path === root && flags === 'r' ? fake : undefined)
    return fake
  }

  it('closes the directory handle when directory fsync fails', async () => {
    const fake = hookDirectoryOpen(
      vi.fn(async () => {
        throw new Error('EINVAL: sync')
      })
    )

    // Tolerating unsupported directory fsync must not turn into a leak.
    await expect(appendJournalRows(root, [ROW])).resolves.toBeUndefined()
    expect(fake.sync).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('closes the directory handle when directory fsync succeeds', async () => {
    const fake = hookDirectoryOpen(vi.fn(async () => undefined))

    await expect(appendJournalRows(root, [ROW])).resolves.toBeUndefined()
    expect(fake.sync).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })
})
