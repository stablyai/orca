import type * as JournalPublicRead from '../../../../agent-session-journal/projection/journal-public-read'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
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
    renders.count = 0

    const { read } = await readThrough(journal, 1, start, [() => remove(journal, 'z-question')])

    expect(read).toEqual(['question', 'answer', 'more'])
    expect(renders.count).toBe(7)
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
