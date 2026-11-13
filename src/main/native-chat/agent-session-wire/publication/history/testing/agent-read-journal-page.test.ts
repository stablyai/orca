import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalMessageItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { journalAgentReadIndex } from '../../../../agent-session-journal/projection/journal-agent-read-index'
import { agentChatEntryOf } from '../../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentReadEntry } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import { isMobileE2EETextPayloadWithinLimit } from '../../../../../runtime/rpc/mobile/e2ee/mobile-e2ee-outbound-admission'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import {
  readAgentJournalPage,
  type AgentReadJournalPage,
  type AgentReadJournalPosition
} from '../agent-read-journal-page'
import { readAgentSessionHistory } from '../agent-session-history-page'
import { agentSessionSendBodyFingerprint } from '../../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { buildJournalQueueRow } from '../../../../agent-session-journal/queued-messages/journal-queue-events'
import {
  append,
  at,
  base,
  closeAgentReadJournals,
  HISTORY_CONTENT_BYTES,
  identity,
  key,
  message,
  publicEntries,
  readForward,
  resetWork,
  seed,
  status,
  tail,
  textOf,
  texts,
  waiting
} from './agent-read-journal-fixture'

afterEach(closeAgentReadJournals)

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

/** A hand-off rejected with nothing known about delivery, as an earlier build saved it. */
function rejectedUnconfirmed(
  clientMessageId: string
): Parameters<AgentSessionJournal['resolveDispatch']>[0] {
  const input = {
    clientMessageId,
    state: 'rejected',
    fence: 1,
    reason: 'unconfirmed',
    rejection: { kind: 'unconfirmed' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the saved unconfirmed rejection shape the queue reviewers' probe writes; the reducer reads only these fields.
  return input as unknown as Parameters<AgentSessionJournal['resolveDispatch']>[0]
}

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
      cursor: { epoch: journal.cursor().epoch, sequence: 2 }
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
    expect(after).toEqual({ cursor: { epoch: journal.cursor().epoch, sequence: 3 } })
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
      cursor: { epoch: journal.cursor().epoch, sequence: 1 }
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

it.each([1, 2])(
  'continues a row naming two ids for one send at limit %i: once, in place',
  async (limit) => {
    const user = (text: string): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
    const accepted = key(1)
    const echo = key(0)
    const journal = await seed(
      0,
      () => null,
      (seq) => [
        {
          ...base,
          kind: 'submission',
          seq,
          clientMessageId: 'send-1',
          payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, user('hi')),
          providerHandle: { kind: 'codex', threadId: 'thread-1' },
          body: user('hi')
        },
        {
          ...base,
          kind: 'dispatch',
          seq: seq + 1,
          clientMessageId: 'send-1',
          state: 'accepted',
          providerItemId: accepted,
          reason: null
        },
        {
          ...base,
          kind: 'lifecycle-batch',
          seq: seq + 2,
          settlementId: 'echoes',
          mutations: [
            { kind: 'item', itemId: echo, revision: 1, body: user('hi') },
            { kind: 'item', itemId: 'b', revision: 1, body: message('b') },
            { kind: 'item', itemId: accepted, revision: 1, body: user('hi') },
            { kind: 'item', itemId: 'c', revision: 1, body: message('c') }
          ]
        }
      ]
    )
    expect([journal.canonicalItemId(echo), journal.canonicalItemId(accepted)]).toEqual([
      'orca:send-1',
      'orca:send-1'
    ])

    const read = readForward(journal, limit, {
      cursor: { epoch: 'epoch-1', sequence: 3 }
    })

    expect(texts(read)).toEqual(['hi', 'b', 'c'])
    expect(read.after).toEqual({ cursor: { epoch: 'epoch-1', sequence: 4 } })
  }
)

const TOO_LARGE: AgentReadEntry = {
  kind: 'message',
  role: 'system',
  text: 'This part of the chat was too large to show.'
}

it.each([1, 2, 50])(
  'reads a reply no page can carry as the history too-large marker, at limit %i',
  async (limit) => {
    const journal = await seed(1, () => message('before'))
    const start = { cursor: journal.cursor() }
    // 70,000 blocks of 64 characters: past any page, and no block can be shortened further.
    const blocks: AgentJournalItemBody = {
      kind: 'message',
      role: 'assistant',
      blocks: Array.from({ length: 70_000 }, () => ({ type: 'text', text: 'x'.repeat(64) }))
    }
    const long = (name: string): AgentJournalItemBody =>
      message(`${name}:${'y'.repeat(3 * 1024 * 1024)}`)
    await journal.appendLifecycleBatch({
      settlementId: 'oversized',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          itemId: 'long-1',
          body: long('long 1'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          itemId: 'long-2',
          body: long('long 2'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        { kind: 'item', itemId: 'blocks', body: blocks, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      ]
    })
    const carried = (page: AgentReadJournalPage) => {
      expect(
        isMobileE2EETextPayloadWithinLimit(JSON.stringify({ id: 'r', ok: true, result: page }))
      ).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(page.ok ? page.entries : []))).toBeLessThanOrEqual(
        HISTORY_CONTENT_BYTES + 1
      )
    }
    const label = (entry: AgentReadEntry) =>
      JSON.stringify(entry) === JSON.stringify(TOO_LARGE) ? 'marker' : textOf(entry).split(':')[0]

    const oversizedLatest = tail(journal, limit)
    carried(oversizedLatest)
    expect(oversizedLatest.entries.at(-1)).toEqual(TOO_LARGE)
    await append(journal, 9, message('after'))

    const latest = tail(journal, limit)
    carried(latest)
    expect(latest.entries.at(-1)).toEqual({ kind: 'message', role: 'assistant', text: 'after' })
    if (limit > 1) {
      expect(latest.entries.at(-2)).toEqual(TOO_LARGE)
    }

    const forward = readForward(journal, limit, start)
    forward.pages.forEach(carried)
    expect(forward.entries.map(label)).toEqual(['long 1', 'long 2', 'marker', 'after'])
    expect(forward.entries.filter((entry) => 'shortened' in entry)).toHaveLength(2)
    expect(forward.after).toEqual({ cursor: journal.cursor() })
  }
)

it.each([1_000, 10_000])(
  'shows both sends a queued card settles, %i replies in, without a rebuild',
  async (count) => {
    const journal = await seed(count, (index) => message(`reply ${index}`))
    const user = (text: string): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    })
    for (const id of ['old', 'new']) {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        body: user(id),
        fence: 1,
        handoverRecorded: true,
        queuedMessageId: 'card'
      })
      await journal.resolveDispatch({
        clientMessageId: id,
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.resolveDispatch(rejectedUnconfirmed(id))
    }
    const before = tail(journal, 3)
    expect(texts(before)).toEqual([
      `reply ${count - 3}`,
      `reply ${count - 2}`,
      `reply ${count - 1}`
    ])
    const work = resetWork(journal)

    await journal['rowWriter'].enqueue((seq, ts) =>
      buildJournalQueueRow(
        journal.queuedMessages.inputState(),
        'card',
        {
          op: 'queued',
          body: user('new'),
          position: 1,
          queuedAt: null,
          attempt: 'new',
          recovers: 'old'
        },
        seq,
        ts
      )
    )

    expect(publicEntries(journal).slice(-2).map(textOf)).toEqual(['old', 'new'])
    expect(texts(tail(journal, 3))).toEqual([`reply ${count - 1}`, 'old', 'new'])
    expect(texts(tail(journal, 3))).toEqual([`reply ${count - 1}`, 'old', 'new'])
    expect(texts(readForward(journal, 1, before.next))).toEqual(['old', 'new'])
    expect(work.builds).toBe(0)
    expect(work.upkeep).toBe(2)
  }
)

it.each([1_000, 10_000])(
  'keeps Stop-note dependencies to the live notes through %i deletions',
  async (count) => {
    const journal = await seed(1, () => message('reply'))
    const index = journalAgentReadIndex(journal)
    tail(journal, 1)
    const turn = (turnId: string) =>
      agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 })
    const note = (name: string, turnName: string, body = STOP_NOTE) => ({
      kind: 'item' as const,
      itemId: agentJournalSubmissionKey(`stop:${name}`),
      body,
      turnScope: { kind: 'turn' as const, turnItemId: turn(turnName) }
    })
    const batch = (
      settlementId: string,
      mutations: Parameters<AgentSessionJournal['appendLifecycleBatch']>[0]['mutations']
    ) => journal.appendLifecycleBatch({ settlementId, fence: 1, mutations })
    const many = Array.from({ length: count }, (_, i) => note(`n${i}`, `t${i}`))
    await batch('make', [
      ...many,
      note('sibling-1', 'shared'),
      note('sibling-2', 'shared'),
      note('mover', 'from'),
      note('shape', 'shaped')
    ])
    expect(index.noteDependencies()).toEqual({ turns: count + 3, notes: count + 4 })

    await batch('retire', [
      ...many.map(({ itemId }) => ({ kind: 'tombstone' as const, itemId })),
      { kind: 'tombstone', itemId: agentJournalSubmissionKey('stop:sibling-1') },
      note('mover', 'to'),
      note('shape', 'shaped', status('stopped'))
    ])
    // Left: `shared` (sibling-2) and `to` (mover).
    expect(index.noteDependencies()).toEqual({ turns: 2, notes: 2 })

    await batch('restore', [note('shape', 'shaped')])
    expect(index.noteDependencies()).toEqual({ turns: 3, notes: 3 })
  }
)

it.each([1, 2])(
  'reads one write forward in presented order, not stored-id order, at limit %i',
  async (limit) => {
    const journal = await seed(1, () => message('before'))
    const start = { cursor: journal.cursor() }
    await journal.appendLifecycleBatch({
      settlementId: 'exchange',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          itemId: 'z-question',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'question' }] },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          itemId: 'a-answer',
          body: message('answer'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
    })
    const history = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: start.cursor,
      limit: 50
    })

    const forward = readForward(journal, limit, start)

    expect(texts(forward)).toEqual(['question', 'answer'])
    expect(publicEntries(journal).slice(-2).map(textOf)).toEqual(['question', 'answer'])
    expect(
      history.ok &&
        history.page.items.flatMap((item) => agentChatEntryOf(item, waiting) ?? []).map(textOf)
    ).toEqual(['question', 'answer'])
    expect(forward.after).toEqual({ cursor: journal.cursor() })
  }
)
