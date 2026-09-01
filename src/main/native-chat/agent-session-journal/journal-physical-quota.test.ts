import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { JOURNAL_SNAPSHOT_FILE } from './journal-log-file'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { journalDirectoryBytes } from './journal-physical-quota'
import { openAgentSessionJournal } from './journal-store-factory'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-quota-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('journal physical quota peaks', () => {
  it('refuses an epoch replacement whose staging peak exceeds the quota', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 8_000 }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      autoCompact: false
    })
    await journal.appendItem(item(1), body('old'.repeat(500)), { fence: 1 })
    const epoch = journal.epoch

    await expect(
      journal.replaceEpochItems('handle_forked', 2, [
        { identity: item(2), body: body('replacement'.repeat(250)) }
      ])
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(journal.epoch).toBe(epoch)
    expect((await readdir(root)).some((name) => name.startsWith('.epoch-replacement-'))).toBe(false)
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)
  })

  it('refuses schema quarantine when its peak copy would exceed the quota', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 7_000 }
    await openAgentSessionJournal({ identity: IDENTITY, journalDir: root, limits })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as Record<string, unknown>
    snapshot.v = 99
    snapshot.items = [{ body: { kind: 'future', payload: 'x'.repeat(4_000) } }]
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')
    const reopened = await openAgentSessionJournal({ identity: IDENTITY, journalDir: root, limits })

    await expect(reopened.rollEpoch('schema_unreadable', 2)).rejects.toMatchObject({
      code: 'journal_bound_exceeded'
    })

    expect(reopened.isReadOnly).toBe(true)
    expect((await readdir(root)).some((name) => name.startsWith('quarantine-'))).toBe(false)
    expect(await journalDirectoryBytes(root)).toBeLessThanOrEqual(limits.maxSessionBytes)
  })

  it('does not rename an invalid snapshot when the directory is already full', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 2_000 }
    await openAgentSessionJournal({ identity: IDENTITY, journalDir: root, limits })
    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    await writeFile(snapshotPath, '{"invalid":', 'utf8')
    const current = await journalDirectoryBytes(root)
    await writeFile(
      join(root, 'quota-filler'),
      'x'.repeat(Math.max(0, limits.maxSessionBytes - current)),
      'utf8'
    )

    await expect(
      openAgentSessionJournal({ identity: IDENTITY, journalDir: root, limits })
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })
    expect(await readFile(snapshotPath, 'utf8')).toBe('{"invalid":')
    expect((await readdir(root)).some((name) => name.startsWith('quarantine-snapshot-'))).toBe(
      false
    )
  })

  it('counts pre-existing durable-write temps while staging an epoch replacement', async () => {
    const limits = { ...DEFAULT_JOURNAL_PAYLOAD_LIMITS, maxSessionBytes: 8_000 }
    const journal = await openAgentSessionJournal({
      identity: IDENTITY,
      journalDir: root,
      limits,
      autoCompact: false
    })
    await journal.appendItem(item(1), body('old'), { fence: 1 })
    // Simulate a temp left by a crash. Replacement must refuse before writing
    // its epoch row or creating a staging blob beside this file.
    await writeFile(join(root, 'snapshot.json.crashed-write.tmp'), 'x'.repeat(7_500), 'utf8')
    const epoch = journal.epoch

    await expect(
      journal.replaceEpochItems('handle_forked', 2, [{ identity: item(2), body: body('new') }])
    ).rejects.toMatchObject({ code: 'journal_bound_exceeded' })

    expect(journal.epoch).toBe(epoch)
    expect((await readdir(root)).some((name) => name.startsWith('.epoch-replacement-'))).toBe(false)
  })
})
