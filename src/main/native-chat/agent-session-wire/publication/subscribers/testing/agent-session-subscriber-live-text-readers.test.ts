import { expect, it } from 'vitest'
import {
  forgetEndedTurnRows,
  framesWithin,
  liveTextRecipients,
  noteLiveRowsHeld,
  noteLiveTextReadersChanged,
  sentRowsAfter,
  sessionLiveTextFanOut,
  sessionLiveTextReaders
} from '../agent-session-subscriber-live-text-readers'
import { publishSubscriberLiveText } from '../agent-session-subscriber-live-text'
import type { SubscriberDeliveryPort } from '../agent-session-subscriber-catch-up'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal } from '../../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from '../agent-session-subscribe-input'

const subscriber = (fields: Partial<Subscriber>): Subscriber =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readers read only these fields.
  ({ id: 'reader', sessionId: 'session', ...fields }) as Subscriber

it('still reads a row an older reader takes, beside a shown phone that no longer takes it', () => {
  const phone = subscriber({
    id: 'phone',
    liveTextViewer: 'phone',
    liveTextShown: true,
    holdsTextBase: () => true,
    liveShortened: new Set(['reply'])
  })
  const olderDesktop = subscriber({ id: 'desktop' })
  const readers = sessionLiveTextReaders(
    new Map([
      ['phone', phone],
      ['desktop', olderDesktop]
    ])
  )
  // The phone's group skips the row; the older desktop's group, which takes whole rows, does not.
  expect(readers?.groups?.map((group) => [group.shown, group.takes?.('reply')])).toEqual([
    [true, false],
    [false, undefined]
  ])
  const phoneOnly = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(phoneOnly?.takes?.('reply')).toBe(false)
})

it('skips a row a reader was sent but can no longer append to, until its save gives the base back', () => {
  let holdsBase = false
  const phone = subscriber({
    id: 'phone',
    liveTextViewer: 'phone',
    liveTextShown: true,
    holdsTextBase: () => holdsBase,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the key is read.
    liveSent: new Map([['reply', {} as never]])
  })
  const readers = sessionLiveTextReaders(new Map([['phone', phone]]))
  expect(readers?.awaitsBase?.('reply')).toBe(true)
  expect(readers?.awaitsBase?.('other')).toBe(false)
  holdsBase = true
  expect(readers?.awaitsBase?.('reply')).toBe(false)
})

it('does not send a row whole again while it waits for its save to restore its append base', async () => {
  const cursor = { epoch: 'e', sequence: 5 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publication reads only the cursor.
  const journal = { cursor: () => cursor } as unknown as SqlAgentSessionJournal
  const bases = new Set(['kept'])
  const sent: string[][] = []
  const reader = subscriber({ cursor, boundedFrames: false, holdsTextBase: (id) => bases.has(id) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publication uses only hooks and emit.
  const port = {
    hooks: {},
    emit: async (_target: unknown, event: AgentSessionSubscribeEvent) => {
      sent.push(event.type === 'batch' ? event.batch.items.map((item) => item.itemId) : [])
    }
  } as unknown as SubscriberDeliveryPort
  const live = (id: string, text: string): AgentJournalRenderItem => ({
    itemId: id,
    revision: 1,
    sequence: 5,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  })
  const publish = (items: AgentJournalRenderItem[]) =>
    publishSubscriberLiveText(port, {
      sessionId: 'session',
      journal,
      fence: 1,
      items,
      subscribers: [reader],
      hostNow: 0
    })
  await publish([live('kept', 'a'), live('evicted', 'b')])
  // The second row's base is gone: the readers skip it, and the next windows carry only the first.
  expect(sessionLiveTextReaders(new Map([['reader', reader]]))?.awaitsBase?.('evicted')).toBe(true)
  await publish([live('kept', 'aa')])
  await publish([live('kept', 'aaa')])
  expect(sent.slice(1)).toEqual([['kept'], ['kept']])
  expect(sessionLiveTextReaders(new Map([['reader', reader]]))?.awaitsBase?.('evicted')).toBe(true)
  // A provider timeline's row (it saves only at block ends) still goes whole, as before.
  await publish([live('kept', 'aaaa'), live('evicted', 'bb')])
  expect(sent.at(-1)).toEqual(['kept', 'evicted'])
})

it('keeps a row awaiting its append base, and lets go of one whose turn ended', () => {
  const bases = new Map<string, boolean | null>([
    ['awaiting', false],
    ['ended', null]
  ])
  const reader = subscriber({ holdsTextBase: (id) => (bases.has(id) ? bases.get(id)! : false) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: carrying a row reads none of it.
  const row = {} as never
  const before = new Map([
    ['awaiting', row],
    ['ended', row]
  ])
  // Unbounded otherwise: every finished reply would ride along in each later publication.
  expect([...sentRowsAfter(reader, before, []).keys()]).toEqual(['awaiting'])
})

it("lets go of an ended turn's rows though their append bases left the cache first", () => {
  const reply = (itemId: string, turnItemId: string) => ({
    source: {
      itemId,
      revision: 1,
      sequence: 4,
      observedAt: 1,
      turnScope: { kind: 'turn' as const, turnItemId },
      body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] }
    },
    sent: {} as never,
    bytes: 1
  })
  const reader = subscriber({
    // Evicted: the sender holds no base for either, so neither reads as ended.
    holdsTextBase: () => false,
    liveSent: new Map([
      ['finished', reply('finished', 'turn-1')],
      ['running', reply('running', 'turn-2')]
    ])
  })
  forgetEndedTurnRows(reader, {
    type: 'batch',
    sessionId: 'session',
    fence: 1,
    batch: {
      cursor: { epoch: 'e', sequence: 5 },
      items: [
        {
          itemId: 'turn-1',
          revision: 2,
          sequence: 5,
          observedAt: 1,
          turnScope: { kind: 'thread' },
          body: { kind: 'turn', turnId: 't1', state: 'completed' }
        }
      ],
      removedItemIds: [],
      submissions: []
    }
  })
  expect([...reader.liveSent!.keys()]).toEqual(['running'])
})

it('splits one publication into frames that each stay within the budget', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: splitting reads only bytes.
  const row = (bytes: number) => ({ bytes }) as never
  const frames = framesWithin([row(40), row(40), row(30), row(90), row(10)], 100)
  expect(frames.map((frame) => frame.length)).toEqual([2, 1, 2])
})

it('owes a window with no rows only to members holding live rows, including ones sent rows later', () => {
  const holding = subscriber({
    id: 'holding',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the key is read.
    liveSent: new Map([['timeline', {} as never]])
  })
  const later = subscriber({ id: 'later' })
  const idle = subscriber({ id: 'idle' })
  const [group] = sessionLiveTextFanOut(
    new Map([
      ['holding', holding],
      ['later', later],
      ['idle', idle]
    ])
  ).groups
  const owed = () => [...liveTextRecipients(group!, false)].map((member) => member.id)
  expect(owed()).toEqual(['holding'])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the key is read.
  later.liveSent = new Map([['timeline', {} as never]])
  noteLiveRowsHeld(later)
  expect(owed()).toEqual(['holding', 'later'])
  holding.liveSent = new Map()
  expect(owed()).toEqual(['later'])
  expect([...liveTextRecipients(group!, true)]).toHaveLength(3)
})

it('lets go of every holder once the session it was grouped in changes', () => {
  const holding = subscriber({
    id: 'holding',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the key is read.
    liveSent: new Map([['timeline', {} as never]])
  })
  const session = new Map([['holding', holding]])
  const [group] = sessionLiveTextFanOut(session).groups
  session.delete('holding')
  noteLiveTextReadersChanged(session)
  expect(group!.holders.size).toBe(0)
  // A row it gets now belongs to no group, so no stale set takes it back.
  noteLiveRowsHeld(holding)
  expect(group!.holders.size).toBe(0)
})
