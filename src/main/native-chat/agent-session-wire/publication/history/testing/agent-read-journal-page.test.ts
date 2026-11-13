import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemBody
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
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
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import type { JournalRow } from '../../../../agent-session-journal/durable-rows/journal-row-schema'
import { journalAgentReadIndex } from '../../../../agent-session-journal/projection/journal-agent-read-index'
import { agentChatEntryOf } from '../../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentReadEntry } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import { isMobileE2EETextPayloadWithinLimit } from '../../../../../runtime/rpc/mobile/e2ee/mobile-e2ee-outbound-admission'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { readAgentJournalPage, type AgentReadJournalPosition } from '../agent-read-journal-page'
import { agentJournalItemForWire } from '../agent-session-item-wire-form'

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

const message = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
const status = (text: string, tone?: 'error'): AgentJournalItemBody => ({
  kind: 'status',
  text,
  ...(tone ? { tone } : {})
})
const at = (index: number): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: `turn-${index}`,
  ordinal: 0
})
const key = (index: number) => agentJournalItemKey(at(index))
const base = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: 'epoch-1', fence: 1, ts: 1_000 }

/** A journal saved before opening: one row per `bodies` entry (null leaves no item), then
 *  `extra` rows. Imported-style: no turn markers. */
async function seed(
  count: number,
  body: (index: number) => AgentJournalItemBody | null,
  extra: (seq: number) => JournalRow[] = () => []
): Promise<AgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-read-page-'))
  roots.push(root)
  const { db } = openTestJournalHostDatabase(root)
  db.exec('BEGIN IMMEDIATE')
  publishTestJournalEpoch(db, identity.sessionId, base.epoch)
  insertTestJournalRow(db, identity.sessionId, {
    ...base,
    kind: 'epoch',
    seq: 1,
    reason: 'session_created',
    providerHandle: agentSessionJournalProviderHandle(identity)
  })
  let seq = 1
  for (let index = 0; index < count; index++) {
    const item = body(index)
    if (item) {
      seq += 1
      insertTestJournalRow(db, identity.sessionId, {
        ...base,
        kind: 'item',
        seq,
        itemId: key(index),
        revision: 1,
        body: item
      })
    }
  }
  for (const row of extra(seq + 1)) {
    insertTestJournalRow(db, identity.sessionId, row)
  }
  db.exec('COMMIT')
  return journals.open({ identity, stateDirectory: root })
}

const append = (journal: AgentSessionJournal, index: number, body: AgentJournalItemBody) =>
  journal.appendItem(at(index), body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })

const tail = (journal: AgentSessionJournal, limit: number) => {
  const page = readAgentJournalPage(journal, { limit }, waiting)
  if (!page.ok) {
    throw new Error('expected a page')
  }
  return page
}
const textOf = (entry: AgentReadEntry) => ('text' in entry ? String(entry.text) : '')
const texts = (page: { entries: AgentReadEntry[] }) => page.entries.map(textOf)

/** What the existing public timeline presents as agent-read entries, oldest first. */
const publicEntries = (journal: AgentSessionJournal) =>
  journal
    .statusRead()
    .items.flatMap((item) => agentChatEntryOf(agentJournalItemForWire(item).item, waiting) ?? [])

function resetWork(journal: AgentSessionJournal) {
  const work = journalAgentReadIndex(journal).work
  Object.assign(work, { builds: 0, builtItems: 0, upkeep: 0, nodes: 0, reads: 0 })
  return work
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a saved Stop note's status carries only the failure kind the projection reads.
const STOP_NOTE = {
  kind: 'status',
  text: 'Stopping the turn…',
  tone: 'error',
  failure: { kind: 'cancelUnconfirmed' }
} as AgentJournalItemBody
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host's own restart rejection, as the dispatch reducer tests write it.
const HOST_RESTARTED = {
  reason: DISPATCH_REJECTED_HOST_RESTARTED,
  rejection: { kind: 'hostRestarted' }
} as unknown as Parameters<AgentSessionJournal['rejectPendingSubmissions']>[1]

// A tree of up to 10,000 entries is at most ~1.44·log2 deep; tails stay well under this per read.
const NODES_PER_READ = 40

it.each([1_000, 10_000])(
  'reads a %i-item chat with work bounded by the page and the tree depth',
  async (count) => {
    const journal = await seed(count, (index) => message(`reply ${index}`))
    expect(texts(tail(journal, 3))).toEqual([
      `reply ${count - 3}`,
      `reply ${count - 2}`,
      `reply ${count - 1}`
    ])
    expect(journalAgentReadIndex(journal).work).toMatchObject({ builds: 1, builtItems: count })
    const work = resetWork(journal)
    const publicRead = vi.spyOn(journal, 'publicRead')

    for (let read = 0; read < 15; read++) {
      tail(journal, 3)
    }
    expect(work.reads).toBe(15 * 4)
    expect(work.nodes).toBeLessThanOrEqual(15 * NODES_PER_READ)

    const before = tail(journal, 1)
    resetWork(journal)
    await append(journal, count, message('newest reply'))
    expect(work.upkeep).toBe(1)
    expect(work.nodes).toBeLessThanOrEqual(NODES_PER_READ)
    const next = readAgentJournalPage(journal, { limit: 3, after: before.next }, waiting)
    expect(next).toMatchObject({ ok: true, entries: [{ text: 'newest reply' }], limited: false })
    expect(texts(tail(journal, 1))).toEqual(['newest reply'])
    expect(work.builds).toBe(0)
    expect(publicRead).not.toHaveBeenCalled()
  }
)

it.each([1_000, 10_000])('never walks a deleted or empty suffix: %i items', async (count) => {
  // One answer, then count − 1 empty messages and hidden status frames.
  const sparse = await seed(count, (index) =>
    index === 0 ? message('the answer') : index % 2 ? message('   ') : status('working')
  )
  expect(texts(tail(sparse, 1))).toEqual(['the answer'])
  const sparseWork = resetWork(sparse)
  for (let read = 0; read < 5; read++) {
    expect(texts(tail(sparse, 1))).toEqual(['the answer'])
  }
  expect(sparseWork.reads).toBe(5)
  expect(sparseWork.nodes).toBe(5)

  // Delete the newest half after the index exists.
  const dense = await seed(count, (index) => message(`reply ${index}`))
  tail(dense, 1)
  const work = resetWork(dense)
  for (let index = count / 2; index < count; index++) {
    await dense.appendTombstone(at(index), { fence: 1 })
  }
  expect(work.upkeep).toBe(count / 2)
  resetWork(dense)
  for (let read = 0; read < 5; read++) {
    expect(texts(tail(dense, 1))).toEqual([`reply ${count / 2 - 1}`])
  }
  expect(work.reads).toBe(5 * 2)
  expect(work.nodes).toBeLessThanOrEqual(5 * NODES_PER_READ)
  expect(work.builds).toBe(0)
})

it.each([1_000, 10_000])(
  'revises eligibility and content of %i items without moving the rest',
  async (count) => {
    const journal = await seed(count, (index) =>
      index === 5 ? status('early note') : message(`reply ${index}`)
    )
    tail(journal, 1)
    const work = resetWork(journal)

    await append(journal, 5, status('early note failed', 'error'))
    await append(journal, 7, message(''))
    await append(journal, count - 1, message('revised newest'))
    expect(work.upkeep).toBe(3)
    expect(work.nodes).toBeLessThanOrEqual(3 * 2 * NODES_PER_READ)
    expect(texts(tail(journal, 2))).toEqual([`reply ${count - 2}`, 'revised newest'])
    const page = readAgentJournalPage(journal, { limit: 100 }, waiting)
    expect(page.ok && page.entries.length).toBe(100)

    await append(journal, 5, status('early note'))
    await append(journal, 7, message('reply 7 again'))
    expect(work.builds).toBe(0)
    expect(work.upkeep).toBe(5)
  }
)

it('matches the public timeline through Stop notes, rejected sends, empty heads and epochs', async () => {
  const turn = agentJournalItemKey(at(100))
  const note = agentJournalSubmissionKey('stop:1')
  const journal = await seed(
    3,
    (index) => message(`reply ${index}`),
    (seq) => [
      {
        ...base,
        kind: 'item',
        seq,
        itemId: turn,
        revision: 1,
        body: { kind: 'turn', turnId: 'turn-a', state: 'running' }
      },
      {
        ...base,
        kind: 'item',
        seq: seq + 1,
        itemId: note,
        revision: 1,
        body: STOP_NOTE,
        turnScope: { kind: 'turn', turnItemId: turn }
      }
    ]
  )
  const sameAsPublic = () =>
    expect(readAgentJournalPage(journal, { limit: 100 }, waiting)).toMatchObject({
      ok: true,
      entries: publicEntries(journal)
    })
  sameAsPublic()

  // The turn's end changes how its Stop note reads, with no row for the note itself.
  await journal.appendItem(
    at(100),
    { kind: 'turn', turnId: 'turn-a', state: 'interrupted' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  sameAsPublic()

  // A send, then its rejection, changes presentation through submission and dispatch rows.
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'please continue' }] }
  })
  sameAsPublic()
  await journal.rejectPendingSubmissions(1, HOST_RESTARTED)
  sameAsPublic()

  // A head that shows nothing new advances the cursor and returns no entry.
  const before = tail(journal, 1)
  await append(journal, 200, status('working'))
  const after = readAgentJournalPage(journal, { limit: 3, after: before.next }, waiting)
  expect(after).toMatchObject({ ok: true, entries: [] })
  expect(after.ok && after.next.cursor.sequence).toBeGreaterThan(before.next.cursor.sequence)

  // A new epoch starts a new history; the old cursor no longer reads.
  const work = resetWork(journal)
  await journal.rollEpoch('corruption', 1)
  sameAsPublic()
  tail(journal, 1)
  expect(work.builds).toBe(1)
  expect(readAgentJournalPage(journal, { limit: 3, after: before.next }, waiting)).toEqual({
    ok: false
  })
})

it('answers a pending prompt from the live owner, not from the index', async () => {
  const journal = await seed(1, () => ({
    kind: 'approval',
    title: 'Run the tests?',
    detail: null,
    options: [{ id: 'allow', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }))
  let live = true
  const read = () => readAgentJournalPage(journal, { limit: 1 }, () => live)
  expect(read()).toMatchObject({ entries: [{ kind: 'approval', pending: true }] })
  const work = resetWork(journal)
  live = false
  expect(read()).toMatchObject({ entries: [{ kind: 'approval', pending: false }] })
  expect(work.upkeep).toBe(0)
})

it.each([1, 2])(
  'continues a row naming [a, b, a, c] at limit %i: each once, current content',
  async (limit) => {
    const mutation = (id: string, revision: number, text: string) => ({
      kind: 'item' as const,
      itemId: id,
      revision,
      body: message(text)
    })
    const journal = await seed(
      1,
      () => message('before'),
      (seq) => [
        {
          ...base,
          kind: 'lifecycle-batch',
          seq,
          settlementId: 'batch',
          mutations: [
            mutation('a', 1, 'a first'),
            mutation('b', 1, 'b'),
            mutation('a', 2, 'a revised'),
            mutation('c', 1, 'c')
          ]
        }
      ]
    )
    let after: AgentReadJournalPosition = {
      cursor: { epoch: journal.cursor().epoch, sequence: 2 },
      within: 0
    }
    const read: string[] = []
    for (let page = 0; page < 5; page++) {
      const next = readAgentJournalPage(journal, { limit, after }, waiting)
      if (!next.ok) {
        throw new Error('expected a page')
      }
      read.push(...texts(next))
      after = next.next
      if (!next.limited) {
        break
      }
    }
    expect(read).toEqual(['a revised', 'b', 'c'])
    expect(after).toEqual({ cursor: { epoch: journal.cursor().epoch, sequence: 3 }, within: 0 })
  }
)

it.each([10_000, 100_000])(
  'delivers fifty %i-character replies in pages a remote reply can carry',
  async (size) => {
    const reply = (index: number) => `${index}:"é\\n${'x'.repeat(size)}`
    const journal = await seed(
      50,
      (index) => message(reply(index)),
      (seq) => [
        {
          ...base,
          kind: 'lifecycle-batch',
          seq,
          settlementId: 'big',
          mutations: [0, 1, 2].map((part) => ({
            kind: 'item' as const,
            itemId: `big-${part}`,
            revision: 1,
            body: message(`big ${part}:${'y'.repeat(size * 3)}`)
          }))
        },
        {
          ...base,
          kind: 'item',
          seq: seq + 1,
          itemId: 'huge',
          revision: 1,
          body: message(`huge:${'z'.repeat(3 * 1024 * 1024)}`)
        }
      ]
    )
    const fits = (page: unknown) =>
      isMobileE2EETextPayloadWithinLimit(JSON.stringify({ id: 'r', ok: true, result: page }))

    const latest = tail(journal, 50)
    expect(fits(latest)).toBe(true)
    expect(latest.entries.at(-1)).toMatchObject({ shortened: true })
    expect(textOf(latest.entries.at(-1) ?? { kind: 'error', text: '' }).startsWith('huge:')).toBe(
      true
    )

    let after: AgentReadJournalPosition = {
      cursor: { epoch: journal.cursor().epoch, sequence: 1 },
      within: 0
    }
    const seen: string[] = []
    for (let page = 0; page < 200; page++) {
      const next = readAgentJournalPage(journal, { limit: 50, after }, waiting)
      if (!next.ok) {
        throw new Error('expected a page')
      }
      expect(fits(next)).toBe(true)
      seen.push(...next.entries.map((entry) => textOf(entry).split(':')[0] ?? ''))
      after = next.next
      if (!next.limited) {
        break
      }
    }
    expect(seen).toEqual([
      ...Array.from({ length: 50 }, (_, index) => String(index)),
      'big 0',
      'big 1',
      'big 2',
      'huge'
    ])
  }
)
