// Execution provenance (`JournalItemRow.ownerFence`): the generation whose execution produced an
// item, kept apart from each row's writer fence. Every writer states it; the fold prefers it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { retainedRowReplacement } from '../agent-session-wire/structured-rewind-retained-host-rows'
import type { JournalHostDatabase } from './journal-host-database'
import {
  createTrackedJournalOpener,
  insertTestJournalRowJson,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const SCOPE = AGENT_JOURNAL_THREAD_SCOPE
const TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
}
const TURN_ID = agentJournalItemKey(TURN)
const RUNNING: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }
const SETTLED: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'interrupted' }

let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

type StoredItemWrite = { kind?: string; ownerFence?: number; mutations?: StoredItemWrite[] }

/** Each stored item write's stated provenance, in write order, a lifecycle batch's included. */
function storedOwnerFences(): (number | undefined)[] {
  return liveTestJournalRows(database.db, IDENTITY.sessionId).flatMap((row) => {
    const parsed: StoredItemWrite = JSON.parse(row.rowJson)
    const writes = parsed.kind === 'lifecycle-batch' ? (parsed.mutations ?? []) : [parsed]
    return writes.flatMap((write) => (write.kind === 'item' ? [write.ownerFence] : []))
  })
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({ identity: IDENTITY, stateDirectory: root })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-provenance-'))
  database = openTestJournalHostDatabase(root)
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('execution provenance', () => {
  it("records a provider observation's owner, and a host revision keeps it", async () => {
    const journal = await open()
    await journal.appendItem(TURN, RUNNING, { fence: 4, ownerFence: 3, turnScope: SCOPE })
    // Host bookkeeping under a later writer fence states no owner of its own.
    await journal.appendItem(TURN, SETTLED, { fence: 5, turnScope: SCOPE })

    expect(journal.itemFence(TURN_ID)).toBe(3)
    // Every row states it: none leaves the reader to guess from the writer fence.
    expect(storedOwnerFences()).toEqual([3, 3])
  })

  it('a first write with no stated owner is its writer generation’s', async () => {
    const journal = await open()
    await journal.appendItem(
      item(2),
      { kind: 'status', text: 'note' },
      { fence: 6, turnScope: SCOPE }
    )
    expect(journal.itemFence(agentJournalItemKey(item(2)))).toBe(6)
    expect(storedOwnerFences()).toEqual([6])
  })

  it('a lifecycle batch states it on each item: the batch owner, else the kept value', async () => {
    const journal = await open()
    await journal.appendItem(TURN, RUNNING, { fence: 2, ownerFence: 2, turnScope: SCOPE })
    // A provider batch at the owner's fence creates one item.
    await journal.appendLifecycleBatch({
      settlementId: 'provider',
      fence: 3,
      ownerFence: 3,
      mutations: [{ kind: 'item', identity: item(2), body: RUNNING, turnScope: SCOPE }]
    })
    // A settlement at a later fence revises the first: it keeps that item's owner.
    await journal.appendLifecycleBatch({
      settlementId: 'settlement',
      fence: 4,
      recovered: true,
      mutations: [{ kind: 'item', identity: TURN, body: SETTLED, turnScope: SCOPE }]
    })

    expect(journal.itemFence(TURN_ID)).toBe(2)
    expect(journal.itemFence(agentJournalItemKey(item(2)))).toBe(3)
    expect(storedOwnerFences()).toEqual([2, 3, 2])
  })

  it('survives a reopen from storage', async () => {
    const journal = await open()
    await journal.appendItem(TURN, RUNNING, { fence: 4, ownerFence: 3, turnScope: SCOPE })
    await journals.closeAll()

    expect((await open()).itemFence(TURN_ID)).toBe(3)
  })

  it('epoch replacement carries each item’s provenance', async () => {
    const journal = await open()
    await journal.appendItem(TURN, RUNNING, { fence: 2, ownerFence: 2, turnScope: SCOPE })
    const before = journal.epoch

    await journal.replaceEpochItems('legacy_import', 5, [
      { identity: TURN, body: RUNNING, ownerFence: journal.itemFence(TURN_ID) ?? 0 },
      { identity: item(2), body: { kind: 'status', text: 'new' }, ownerFence: 5 }
    ])

    expect(journal.epoch).not.toBe(before)
    // Written at fence 5, the dead generation's turn is still fence 2's work.
    expect(journal.itemFence(TURN_ID)).toBe(2)
    expect(journal.itemFence(agentJournalItemKey(item(2)))).toBe(5)
  })

  it("a rewind's retained row carries the old fold's provenance; an older record's is never current", () => {
    const row = {
      itemId: TURN_ID,
      body: RUNNING,
      observedAt: 1,
      ownerFence: 2
    }
    expect(retainedRowReplacement(row).ownerFence).toBe(2)
    const { ownerFence: _stated, ...older } = row
    expect(retainedRowReplacement(older).ownerFence).toBe(0)
  })

  it('a stored provenance that is not a fence is dropped, and the row reads as its writer’s', async () => {
    const journal = await open()
    await journal.appendItem(TURN, RUNNING, { fence: 2, ownerFence: 2, turnScope: SCOPE })
    const rows = liveTestJournalRows(database.db, IDENTITY.sessionId)
    const stored = rows.find((row) => row.rowJson.includes('"kind":"item"'))
    const last = rows.at(-1)?.seq
    if (!stored || last === undefined) {
      throw new Error('expected the item row')
    }
    await journals.closeAll()
    database = openTestJournalHostDatabase(root)
    const parsed: Record<string, unknown> = JSON.parse(stored.rowJson)
    insertTestJournalRowJson(
      database.db,
      IDENTITY.sessionId,
      last + 1,
      JSON.stringify({
        ...parsed,
        seq: last + 1,
        revision: Number(parsed.revision) + 1,
        fence: 7,
        ownerFence: -1
      })
    )

    expect((await open()).itemFence(TURN_ID)).toBe(2)
  })
})
