import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { journalDisplayOrder } from '../../../../agent-session-journal/projection/journal-display-order'
import { readAgentJournalPage } from '../agent-read-journal-page'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'agent-read-page',
  workspaceId: 'folder-workspace',
  hostId: 'local',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const journals = createTrackedJournalOpener()
const roots: string[] = []
const waiting = () => true

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const message = (text: string) => ({
  kind: 'message' as const,
  role: 'assistant' as const,
  blocks: [{ type: 'text' as const, text }]
})

/** Imported-style history: assistant messages with no turn markers, then optionally one row that
 *  names two messages at once. */
async function seedJournal(count: number, pairAtEnd = false) {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-read-page-'))
  roots.push(root)
  const { db } = openTestJournalHostDatabase(root)
  const base = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: 'epoch-1', fence: 1, ts: 1_000 }
  db.exec('BEGIN IMMEDIATE')
  publishTestJournalEpoch(db, identity.sessionId, base.epoch)
  insertTestJournalRow(db, identity.sessionId, {
    ...base,
    kind: 'epoch',
    seq: 1,
    reason: 'session_created',
    providerHandle: agentSessionJournalProviderHandle(identity)
  })
  for (let index = 0; index < count; index += 1) {
    insertTestJournalRow(db, identity.sessionId, {
      ...base,
      kind: 'item',
      seq: index + 2,
      itemId: `item-${index}`,
      revision: 1,
      body: message(`reply ${index}`)
    })
  }
  if (pairAtEnd) {
    insertTestJournalRow(db, identity.sessionId, {
      ...base,
      kind: 'lifecycle-batch',
      seq: count + 2,
      settlementId: 'pair',
      mutations: [
        { kind: 'item', itemId: 'pair-a', revision: 1, body: message('first of pair') },
        { kind: 'item', itemId: 'pair-b', revision: 1, body: message('second of pair') }
      ]
    })
  }
  db.exec('COMMIT')
  return journals.open({ identity, stateDirectory: root })
}

it.each([1_000, 10_000])(
  'reads a %i-item chat with work bounded by the page, not its history',
  async (count) => {
    const journal = await seedJournal(count)
    const first = readAgentJournalPage(journal, { limit: 3 }, waiting)
    expect(first).toMatchObject({
      ok: true,
      limited: true,
      entries: [
        { kind: 'message', text: `reply ${count - 3}` },
        { kind: 'message', text: `reply ${count - 2}` },
        { kind: 'message', text: `reply ${count - 1}` }
      ]
    })
    const order = journalDisplayOrder(journal)
    const publicRead = vi.spyOn(journal, 'publicRead')
    order.visits = 0

    for (let read = 0; read < 5; read++) {
      readAgentJournalPage(journal, { limit: 3 }, waiting)
    }
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-new', ordinal: 0 },
      message('newest reply'),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const after = first.ok ? first.next : undefined
    const next = readAgentJournalPage(journal, { limit: 3, after }, waiting)

    expect(next).toMatchObject({
      ok: true,
      limited: false,
      entries: [{ kind: 'message', text: 'newest reply' }]
    })
    const tail = readAgentJournalPage(journal, { limit: 3 }, waiting)
    expect(tail).toMatchObject({ ok: true, entries: [{}, {}, { text: 'newest reply' }] })
    // Six tails each looking one past their three entries, plus catching up the one appended
    // item, however long the chat.
    expect(order.visits).toBe(6 * 4 + 1)
    expect(publicRead).not.toHaveBeenCalled()
  }
)

it('continues inside a row that names several items, skipping and repeating none', async () => {
  const journal = await seedJournal(3, true)
  const start = { cursor: { epoch: journal.cursor().epoch, sequence: 4 }, within: 0 }

  const first = readAgentJournalPage(journal, { limit: 1, after: start }, waiting)
  const second = first.ok
    ? readAgentJournalPage(journal, { limit: 1, after: first.next }, waiting)
    : first

  expect(first).toMatchObject({
    ok: true,
    limited: true,
    entries: [{ text: 'first of pair' }],
    next: { cursor: { sequence: 4 }, within: 1 }
  })
  expect(second).toMatchObject({
    ok: true,
    limited: false,
    entries: [{ text: 'second of pair' }],
    next: { cursor: { sequence: 5 }, within: 0 }
  })
})
