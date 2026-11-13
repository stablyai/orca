import type * as JournalPublicRead from '../../../../agent-session-journal/projection/journal-public-read'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { rewindRefusalBehindClear } from '../../../rewind/structured-rewind-refusal'
import { agentSessionJournalProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { isMobileE2EETextPayloadWithinLimit } from '../../../../../runtime/rpc/mobile/e2ee/mobile-e2ee-outbound-admission'
import {
  readAgentJournalPage,
  type AgentReadJournalPage,
  type AgentReadJournalPosition
} from '../agent-read-journal-page'
import {
  abc,
  at,
  base,
  closeAgentReadJournals,
  HISTORY_CONTENT_BYTES,
  identity,
  journals,
  message,
  publicEntries,
  readThrough,
  remove,
  resetWork,
  reply,
  roots,
  rowAfterReply,
  seed,
  tail,
  textOf,
  texts,
  waiting,
  write
} from './agent-read-journal-fixture'

/** Every item render, so a test can pin a read's work. */
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../agent-session-journal/projection/journal-public-read', async (load) => {
  const actual = await load<typeof JournalPublicRead>()
  return {
    ...actual,
    renderJournalStatusItem: (...args: Parameters<typeof actual.renderJournalStatusItem>) => {
      renders.count++
      return actual.renderJournalStatusItem(...args)
    }
  }
})

afterEach(closeAgentReadJournals)

it.each([
  ['[a, b, c] at limit 1', 1, abc],
  ['[a, b, c] at limit 2', 2, abc],
  ['[a, b] at limit 1', 1, abc.slice(0, 2)]
])(
  'reads the rest of a row whose delivered first item is then deleted: %s',
  async (_, limit, items) => {
    const { journal, start, stillThere } = await rowAfterReply(items)

    const { read, after } = await readThrough(journal, limit, start, [
      async () => {
        await remove(journal, 'a')
        stillThere()
        expect(texts(tail(journal, 3))).toContain('b')
      }
    ])

    expect(read).toEqual(items.map(([, text]) => text))
    expect(after).toEqual({ cursor: journal.cursor() })
  }
)

it('reads the rest of a row split by bytes after its delivered first item is deleted', async () => {
  const long = (name: string) => `${name}:${'y'.repeat(3 * 1024 * 1024)}`
  const { journal, start, stillThere } = await rowAfterReply([
    ['a', long('a')],
    ['b', long('b')],
    ['c', 'c']
  ])

  const { pages, read } = await readThrough(journal, 50, start, [
    async () => {
      await remove(journal, 'a')
      stillThere()
    }
  ])

  expect(texts(pages[0] ?? { entries: [] }).map((text) => text.split(':')[0])).toEqual(['a'])
  expect(read.map((text) => text.split(':')[0])).toEqual(['a', 'b', 'c'])
})

it.each([
  [
    'hides a delivered item',
    abc,
    (j: AgentSessionJournal) => write(j, 'hide', [['a', '']]),
    ['a', 'b', 'c']
  ],
  [
    'hides an unread item',
    abc,
    (j: AgentSessionJournal) => write(j, 'hide', [['b', '']]),
    ['a', 'c']
  ],
  ['deletes an unread item', abc, (j: AgentSessionJournal) => remove(j, 'b'), ['a', 'c']],
  ['removes every remaining item', abc, (j: AgentSessionJournal) => remove(j, 'b', 'c'), ['a']],
  [
    // The row shows it in place; its revising write is a later entry of its own.
    'reveals a hidden unread item',
    [
      ['a', 'a'],
      ['h', ''],
      ['c', 'c']
    ] satisfies [string, string][],
    (j: AgentSessionJournal) => write(j, 'reveal', [['h', 'h']]),
    ['a', 'h', 'c', 'h']
  ],
  [
    'revises an unread item',
    abc,
    (j: AgentSessionJournal) => write(j, 'revise', [['b', 'b revised']]),
    ['a', 'b revised', 'c', 'b revised']
  ]
] as const)('continues a row when another write %s', async (_, items, change, expected) => {
  const { journal, start, stillThere } = await rowAfterReply([...items])

  const { read, after } = await readThrough(journal, 1, start, [
    async () => {
      await change(journal)
      stillThere()
    }
  ])

  expect(read).toEqual(expected)
  expect(after).toEqual({ cursor: journal.cursor() })
})

it.each([
  // Deleted and written again, a delivered item moves after its siblings and isn't read twice
  // in this row.
  ['a delivered item', 'a', ['b', 'c', 'a again'], ['a', 'b', 'c']],
  // An unread item moved past its sibling reads after it.
  ['an unread item', 'b', ['a', 'c', 'b again'], ['a', 'c', 'b again']]
] as const)('continues a row when %s moves', async (_, moved, presented, row) => {
  const { journal, start, stillThere } = await rowAfterReply(abc)

  const { read } = await readThrough(journal, 1, start, [
    async () => {
      await remove(journal, moved)
      await write(journal, 'again', [[moved, `${moved} again`]])
      stillThere()
      expect(texts(tail(journal, 3))).toEqual(presented)
    }
  ])

  // The deleting and rewriting writes each name the item again: later entries, current content.
  expect(read).toEqual([...row, `${moved} again`, `${moved} again`])
})

it.each([
  // A hidden slot later named as a send's provider item: never delivered, so the send reads.
  [
    'an unread hidden item',
    [
      ['a', 'a'],
      ['provider', ''],
      ['b', 'b']
    ],
    ['a', 'b', 'hi']
  ],
  // A delivered slot later named as that send's provider item: the send is already represented.
  [
    'a delivered item',
    [
      ['provider', 'hello'],
      ['a', 'a'],
      ['b', 'b']
    ],
    ['hello', 'a', 'b']
  ]
])('continues a row when %s becomes an alias of a send between reads', async (_, items, row) => {
  const provider = at(50)
  const journal = await seed(
    0,
    () => null,
    (seq) => [
      {
        ...base,
        kind: 'lifecycle-batch',
        seq,
        settlementId: 'row',
        mutations: items.map(([name, text]) => ({
          kind: 'item' as const,
          itemId: name === 'provider' ? agentJournalItemKey(provider) : name,
          revision: 1,
          body:
            name === 'provider'
              ? {
                  kind: 'message' as const,
                  role: 'user' as const,
                  blocks: [{ type: 'text' as const, text }]
                }
              : message(text)
        }))
      }
    ]
  )
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: 'send-1',
    fence: 1,
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
  })
  const start: AgentReadJournalPosition = { cursor: { epoch: 'epoch-1', sequence: 1 } }

  const { pages } = await readThrough(journal, 1, start, [
    async () => {
      await journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'accepted',
        providerIdentity: provider,
        fence: 1
      })
      expect(journal.canonicalItemId(agentJournalItemKey(provider))).toBe('orca:send-1')
    }
  ])

  expect(pages.slice(0, row.length).map(texts)).toEqual(row.map((text) => [text]))
})

it.each([1, 2])(
  'reads a saved row of [z-question, a-answer] as presented at limit %i',
  async (limit) => {
    const journal = await seed(
      0,
      () => null,
      (seq) => [
        {
          ...base,
          kind: 'lifecycle-batch',
          seq,
          settlementId: 'exchange',
          mutations: [
            {
              kind: 'item',
              itemId: 'z-question',
              revision: 1,
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'question' }] }
            },
            { kind: 'item', itemId: 'a-answer', revision: 1, body: message('answer') }
          ]
        }
      ]
    )

    const { read } = await readThrough(
      journal,
      limit,
      { cursor: { epoch: 'epoch-1', sequence: 1 } },
      []
    )

    expect(read).toEqual(['question', 'answer'])
    expect(publicEntries(journal).map(textOf)).toEqual(['question', 'answer'])
  }
)

it.each([1_000, 10_000])(
  'reads a small row after %i replies with work set by the row alone',
  async (count) => {
    const journal = await seed(count, (index) => message(`reply ${index}`))
    const start: AgentReadJournalPosition = { cursor: journal.cursor() }
    await write(journal, 'exchange', [
      ['z-question', 'question'],
      ['a-answer', 'answer'],
      ['m-more', 'more']
    ])
    // The owner's index is built once, by the first read of any kind.
    tail(journal, 1)
    renders.count = 0

    const { read } = await readThrough(journal, 1, start, [() => remove(journal, 'z-question')])

    expect(read).toEqual(['question', 'answer', 'more'])
    // Seven renders read the row; one keeps the index current through the deletion.
    expect(renders.count).toBe(8)
  }
)

// A write of 10,000 items is stored as groups of at most 200, the saved batch limit.
it.each(['saved', 'written'] as const)(
  'carries a cursor inside a 200-item %s batch within the reply bounds',
  async (how) => {
    const items = Array.from(
      { length: 200 },
      (_, index) => `item ${String(index).padStart(5, '0')}`
    )
    const journal =
      how === 'saved'
        ? await seed(
            0,
            () => null,
            (seq) => [
              {
                ...base,
                kind: 'lifecycle-batch',
                seq,
                settlementId: 'batch',
                mutations: items.map((itemId) => ({
                  kind: 'item' as const,
                  itemId,
                  revision: 1,
                  body: message(itemId)
                }))
              }
            ]
          )
        : await seed(1, () => message('before'))
    const start: AgentReadJournalPosition = {
      cursor: how === 'saved' ? { epoch: 'epoch-1', sequence: 1 } : journal.cursor()
    }
    if (how === 'written') {
      await write(
        journal,
        'batch',
        items.map((itemId) => [itemId, itemId])
      )
    }

    const first = readAgentJournalPage(journal, { limit: 1, after: start }, waiting)
    if (!first.ok) {
      throw new Error('expected a page')
    }
    const second = readAgentJournalPage(journal, { limit: 2, after: first.next }, waiting)

    expect(first.next.partial?.count).toBe(200)
    expect(isMobileE2EETextPayloadWithinLimit(reply(first).json)).toBe(true)
    expect(second.ok && texts(second)).toEqual(['item 00001', 'item 00002'])
  }
)

it('keeps a cursor inside a 100,000-slot row within the reply bounds', () => {
  const emitted = Buffer.alloc(100_000 / 8, 0xff).toString('base64url')
  const page: Extract<AgentReadJournalPage, { ok: true }> = {
    ok: true,
    entries: [{ kind: 'message', role: 'assistant', text: 'x'.repeat(HISTORY_CONTENT_BYTES - 64) }],
    next: {
      cursor: { epoch: 'epoch-1', sequence: 1 },
      partial: { row: 2, count: 100_000, fingerprint: 'A'.repeat(22), emitted }
    },
    limited: true
  }

  expect(Buffer.byteLength(reply(page).cursor)).toBeLessThan(32 * 1024)
  expect(isMobileE2EETextPayloadWithinLimit(reply(page).json)).toBe(true)
})

it('resumes a row read in part after the journal reopens, and refuses a cursor cut elsewhere', async () => {
  const { journal, start } = await rowAfterReply(abc)
  const first = readAgentJournalPage(journal, { limit: 1, after: start }, waiting)
  if (!first.ok || !first.next.partial) {
    throw new Error('expected a partial page')
  }
  const partial = first.next.partial
  await journal.close()
  const reopened = await journals.open({ identity, stateDirectory: roots.at(-1) ?? '' })
  const resume = (next: AgentReadJournalPosition) =>
    readAgentJournalPage(reopened, { limit: 5, after: next }, waiting)

  expect(resume(first.next)).toMatchObject({ ok: true, entries: [{ text: 'b' }, { text: 'c' }] })
  // Nothing of the row emitted yet: a valid cursor that reads it whole.
  expect(resume({ ...first.next, partial: { ...partial, emitted: 'AA' } })).toMatchObject({
    entries: [{ text: 'a' }, { text: 'b' }, { text: 'c' }]
  })
  for (const changed of [
    { ...partial, fingerprint: 'A'.repeat(22) },
    { ...partial, count: 4 },
    { ...partial, row: partial.row + 1 }
  ]) {
    expect(resume({ ...first.next, partial: changed })).toEqual({ ok: false })
  }
  await reopened.rollEpoch('corruption', 1)
  expect(resume(first.next)).toEqual({ ok: false })
})

const clear = (
  journal: AgentSessionJournal,
  operationId: string,
  receipt = { write: () => {}, committed: () => {} }
) => journal.context.clear({ operationId, afterFence: 1, clearedAt: 1_000 }, receipt)
const CLEARED = { kind: 'message', role: 'system', text: 'Context cleared' } as const

/** APPLE and BANANA, then `/clear`, then CHERRY, with cursors cut before the clear. */
async function clearedChat() {
  const journal = await seed(0, () => null)
  await write(journal, 'apple', [['apple', 'APPLE']])
  await write(journal, 'banana', [['banana', 'BANANA']])
  const full = tail(journal, 100)
  const start: AgentReadJournalPosition = { cursor: { epoch: journal.cursor().epoch, sequence: 1 } }
  const partial = readAgentJournalPage(journal, { limit: 1, after: start }, waiting)
  await clear(journal, 'clear-1')
  return { journal, full, partial }
}

it('reads only the current context after /clear, from its divider', async () => {
  const { journal } = await clearedChat()
  expect(tail(journal, 100)).toMatchObject({ entries: [CLEARED], limited: false })

  await write(journal, 'cherry', [['cherry', 'CHERRY']])

  expect(tail(journal, 100)).toMatchObject({
    entries: [CLEARED, { text: 'CHERRY' }],
    limited: false
  })
  expect(tail(journal, 1)).toMatchObject({ entries: [{ text: 'CHERRY' }], limited: true })
  expect(tail(journal, 2)).toMatchObject({ entries: [CLEARED, { text: 'CHERRY' }], limited: false })
  // The archive keeps the old context.
  expect(journal.statusRead().items.some((item) => item.itemId === 'apple')).toBe(true)
})

it('refuses a cursor cut before /clear, and follows one cut after it', async () => {
  const { journal, full, partial } = await clearedChat()
  expect(partial.ok && partial.limited).toBe(true)

  for (const before of [full.next, partial.ok ? partial.next : full.next]) {
    expect(readAgentJournalPage(journal, { limit: 5, after: before }, waiting)).toEqual({
      ok: false
    })
  }
  const fresh = tail(journal, 100)
  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  // An old item revised after the clear stays out of the current context.
  await write(journal, 'apple again', [['apple', 'APPLE revised']])

  await expect(readThrough(journal, 1, fresh.next, [])).resolves.toMatchObject({ read: ['CHERRY'] })
  expect(texts(tail(journal, 100))).toEqual(['Context cleared', 'CHERRY'])
})

it('starts the current context at the newest of repeated clears, and after reopening', async () => {
  const { journal } = await clearedChat()
  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  await clear(journal, 'clear-2')
  await write(journal, 'date', [['date', 'DATE']])
  expect(texts(tail(journal, 100))).toEqual(['Context cleared', 'DATE'])

  await journal.close()
  const reopened = await journals.open({ identity, stateDirectory: roots.at(-1) ?? '' })

  expect(texts(tail(reopened, 100))).toEqual(['Context cleared', 'DATE'])
})

it.each([1_000, 10_000])(
  'reads the current context after %i cleared replies without walking them',
  async (count) => {
    const journal = await seed(count, (index) => message(`reply ${index}`))
    tail(journal, 1)
    const work = resetWork(journal)
    await clear(journal, 'clear')
    await write(journal, 'cherry', [['cherry', 'CHERRY']])

    expect(texts(tail(journal, 100))).toEqual(['Context cleared', 'CHERRY'])
    // Two placements and a walk of the two current entries: tree paths, never the old context.
    expect({ upkeep: work.upkeep, builds: work.builds, reads: work.reads }).toEqual({
      upkeep: 2,
      builds: 0,
      reads: 2
    })
    expect(work.nodes).toBeLessThan(80)
  }
)

/** One completed Claude turn, written in the order QA 5385's real chat committed it (recovered
 *  from that run's journal; see `orca-qa/pr-41815/qa5385-artifacts/banana-sequence.md`): the
 *  send, its hand-over, the previous turn's two late usage revisions, the new turn opening, the
 *  provider accepting the send, the reply written twice with the same text, and three turn
 *  revisions. Identities are shortened; their order and repetitions are the run's. */
async function completedTurn(
  journal: AgentSessionJournal,
  word: string,
  previous?: string,
  answer = word
) {
  const id = `send-${word}`
  const user = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: `Reply with the single word ${word}` }]
  }
  const turn = {
    provider: 'codex' as const,
    threadId: 'thread-1',
    turnId: `turn-${word}`,
    ordinal: 0
  }
  const turnBody = (state: 'running' | 'completed', durationMs?: number) => ({
    kind: 'turn' as const,
    turnId: word,
    state,
    ...(state === 'completed' ? { outcome: 'success' as const } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  })
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: id,
    fence: 1,
    handoverRecorded: true,
    body: user
  })
  await journal.resolveDispatch({
    clientMessageId: id,
    state: 'pending',
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  if (previous) {
    const prior = {
      provider: 'codex' as const,
      threadId: 'thread-1',
      turnId: `turn-${previous}`,
      ordinal: 0
    }
    for (const durationMs of [5, 6]) {
      await journal.appendItem(prior, turnBody('completed', durationMs), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  await journal.appendItem(turn, turnBody('running'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.resolveDispatch({
    clientMessageId: id,
    state: 'accepted',
    providerIdentity: { ...turn, turnId: `user-${word}` },
    fence: 1
  })
  for (let revision = 0; revision < 2; revision++) {
    await journal.appendItem({ ...turn, turnId: `reply-${word}` }, message(answer), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  for (const [state, durationMs] of [
    ['running', 1],
    ['completed', 2],
    ['completed', 3]
  ] as const) {
    await journal.appendItem(turn, turnBody(state, durationMs), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
}

// QA 5385 Q-11: awaits the conversation-unit forward read (plan amendment "#41815
// conversation-unit forward read"). Expected to fail until then. The byte-split case keeps the
// run's write order with a 3 MiB answer, so its pages split by bytes.
it.fails.each([
  ['limit 1', 1, 'BANANA'],
  ['limit 2', 2, 'BANANA'],
  ['the default limit', 100, 'BANANA'],
  ['a byte split', 100, `BANANA:${'y'.repeat(3 * 1024 * 1024)}`]
])('reads a completed turn once each, user then answer, at %s', async (_, limit, answer) => {
  const journal = await seed(0, () => null)
  await completedTurn(journal, 'APPLE')
  const after = tail(journal, 100).next
  await completedTurn(journal, 'BANANA', 'APPLE', answer)

  const { pages, read, after: end } = await readThrough(journal, limit, after, [])

  expect(read.map((text) => text.split(':')[0])).toEqual([
    'Reply with the single word BANANA',
    'BANANA'
  ])
  expect(pages.filter((page) => page.limited && page.entries.length === 0)).toEqual([])
  expect(readAgentJournalPage(journal, { limit, after: end }, waiting)).toMatchObject({
    entries: [],
    limited: false
  })
})

it('leaves the read untouched when a clear commits no divider', async () => {
  const { journal } = await clearedChat()
  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  const before = tail(journal, 100)
  const head = journal.cursor()

  // The receipt's write failing rolls the clear back: no divider is committed.
  await expect(
    clear(journal, 'refused', {
      write: () => {
        throw new Error('refused-clear')
      },
      committed: () => {}
    })
  ).rejects.toThrow('refused-clear')

  expect(journal.cursor()).toEqual(head)
  expect(tail(journal, 100)).toEqual(before)
  expect(readAgentJournalPage(journal, { limit: 5, after: before.next }, waiting)).toMatchObject({
    ok: true,
    entries: []
  })
})

it.each(['plain', 'forked'] as const)(
  'rewinds within the current context (%s), keeping its divider, and refuses a target before it',
  async (kind) => {
    const { journal } = await clearedChat()
    await write(journal, 'cherry', [['cherry', 'CHERRY']])
    const before = tail(journal, 100)
    const floor = before.next.floor ?? 0
    const work = resetWork(journal)

    // A rewind to an item before the divider is refused before any agent runs.
    const epoch = journal.cursor().epoch
    expect(
      rewindRefusalBehindClear(journal, { itemId: 'banana', expectedEpoch: epoch })
    ).not.toBeNull()
    expect(rewindRefusalBehindClear(journal, { itemId: 'cherry', expectedEpoch: epoch })).toBeNull()
    expect(tail(journal, 100)).toEqual(before)

    await journal.context.rewind(
      { epoch, sequence: floor },
      1,
      [],
      () => ({ write: () => {}, committed: () => {} }),
      // A provider that forked its history starts a new epoch, as structured rewind recovery does.
      kind === 'forked'
        ? { reason: 'handle_forked', providerHandle: agentSessionJournalProviderHandle(identity) }
        : undefined
    )

    expect(tail(journal, 100)).toMatchObject({ entries: [CLEARED], limited: false })
    const old = readAgentJournalPage(journal, { limit: 5, after: before.next }, waiting)
    if (kind === 'forked') {
      // A new epoch: pre-rewind cursors are refused and the owner rebuilds from what survived.
      expect(old).toEqual({ ok: false })
      expect(work.builds).toBe(1)
    } else {
      // The same epoch: an old cursor reads the removal as nothing new, at the head.
      expect(old).toMatchObject({ ok: true, entries: [], limited: false, next: { floor } })
    }
  }
)
