import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { DEFAULT_JOURNAL_COMPACTION_POLICY } from './journal-compaction'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import { putJournalBlob, readJournalBlob } from './journal-blob-store'
import { boundPayload, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { JournalAppendBudget } from './journal-write-guards'
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function now(): number {
  clock += 1
  return clock
}

function toolBody(output: ReturnType<typeof boundPayload>): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name: 'shell',
    input: {},
    state: 'completed',
    output
  }
}

describe('journal epoch replacement', () => {
  it('publishes one observable replacement and prunes stale root blobs afterward', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8 }
    const stalePayload = 'stale'.repeat(1_000)
    const retainedPayload = 'retained'.repeat(1_000)
    const stale = boundPayload(stalePayload, limits)
    const retained = boundPayload(retainedPayload, limits)
    const published: unknown[] = []
    await putJournalBlob(root, stale.digest, stalePayload)

    await replaceJournalEpoch({
      journalDir: root,
      identity: IDENTITY,
      reason: 'handle_forked',
      fence: 2,
      items: [
        {
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
          body: toolBody(retained),
          blobs: [{ digest: retained.digest, payload: retainedPayload }]
        }
      ],
      budget: new JournalAppendBudget(IDENTITY.sessionId, {
        ...limits,
        maxSessionBytes: 512 * 1024
      }),
      compaction: DEFAULT_JOURNAL_COMPACTION_POLICY,
      now,
      mintEpoch: () => 'epoch-new',
      onSnapshotPublished: (loaded) => published.push(loaded)
    })

    expect(published).toHaveLength(1)
    expect(await readJournalBlob(root, stale.digest)).toBeNull()
    expect(await readJournalBlob(root, retained.digest)).toBe(retainedPayload)
    expect((published[0] as { sizeBytes: number }).sizeBytes).toBe(
      await journalDirectoryBytes(root)
    )
  })

  it('keeps root blobs and reports no publication when replacement never becomes authoritative', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8, maxSessionBytes: 6_000 }
    const stalePayload = 'stale'.repeat(500)
    const stale = boundPayload(stalePayload, limits)
    const published: unknown[] = []
    await putJournalBlob(root, stale.digest, stalePayload)

    await expect(
      replaceJournalEpoch({
        journalDir: root,
        identity: IDENTITY,
        reason: 'handle_forked',
        fence: 2,
        items: [
          {
            identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'x'.repeat(10_000) }]
            }
          }
        ],
        budget: new JournalAppendBudget(IDENTITY.sessionId, limits),
        compaction: DEFAULT_JOURNAL_COMPACTION_POLICY,
        now,
        mintEpoch: () => 'epoch-new',
        onSnapshotPublished: (loaded) => published.push(loaded)
      })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(published).toHaveLength(0)
    expect(await readJournalBlob(root, stale.digest)).toBe(stalePayload)
    expect((await readdir(root)).some((name) => name.startsWith('.epoch-replacement-'))).toBe(false)
  })

  it('charges replacement blobs cumulatively and rolls back staging on quota refusal', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, inlineHeadBytes: 8, maxSessionBytes: 7_000 }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      autoCompact: false,
      now,
      mintEpoch: () => `epoch-${clock}`
    })
    const existingPayload = 'existing'.repeat(250)
    const existing = boundPayload(existingPayload, limits)
    await journal.appendItemWithBlobs(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      toolBody(existing),
      [{ digest: existing.digest, payload: existingPayload }],
      { fence: 1 }
    )

    const replacementPayload = 'replacement'.repeat(200)
    const replacement = boundPayload(replacementPayload, limits)
    const secondPayload = 'second'.repeat(200)
    const second = boundPayload(secondPayload, limits)
    await expect(
      journal.replaceEpochItems('handle_forked', 2, [
        {
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
          body: toolBody(replacement),
          blobs: [{ digest: replacement.digest, payload: replacementPayload }]
        },
        {
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 2 },
          body: toolBody(second),
          blobs: [{ digest: second.digest, payload: secondPayload }]
        }
      ])
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(journal.epoch).toMatch(/^epoch-/)
    expect(await readJournalBlob(root, existing.digest)).toBe(existingPayload)
    expect(await readJournalBlob(root, replacement.digest)).toBeNull()
    expect(await readJournalBlob(root, second.digest)).toBeNull()
    expect((await readdir(root)).some((name) => name.startsWith('.epoch-replacement-'))).toBe(false)
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)
  })
})
