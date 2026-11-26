// A bot asked from an external thread passes the request on; what the helper owes that thread
// depends on the request's purpose and on which request an item is the job of. Follows each case
// from the stored request record through the helper's turn, the place `bot item add` gives the item
// (bots-items-started-in.ts), the persisted item, and the report hint its worker's result carries.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { formatBotItemReportHint } from '../../shared/bots/bot-item-report-hint'
import type { BotItemStatus } from '../../shared/bots/bot-items'
import SyncDatabase from '../sqlite/sync-database'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { botRequestActsFor } from '../runtime/rpc/methods/orchestration/messaging/bot-request-record'
import { itemLinksWithOrigin, itemStartedIn } from '../runtime/rpc/methods/bots-items-started-in'
import { parseItemLink } from '../runtime/rpc/methods/bots-items-write-support'
import { BOT_ITEM_LIMITS } from '../../shared/bots/bot-items'
import { botRulesSections } from './bot-preamble'
import { readBotActingTurn, type BotActingTurn, type BotWakingPlace } from './bot-request-asker'
import type { BotRequestPurpose } from './bot-request-policy'
import { botRequestView, type BotRequestRecord } from './bot-request-view'
import { botItemOfReport } from './bot-item-report-fact'
import type { BotItemsRemote } from './bot-items-ops'
import { migrateBotItems } from './bot-items-schema'
import { BotItemsStore } from './bot-items-store'

vi.mock('../runtime/orchestration/workers/reports/report-follow-up-action', () => ({
  currentCompletionReportDispatchId: () => 'ctx_worker'
}))
let reportedUid = ''
vi.mock('./bot-item-dispatch-facts', () => ({ dispatchItemUid: () => reportedUid }))

const THREAD_URL = 'https://app.slack.com/client/T01/C01/thread/C01-1795415167.287389'
const THREAD: BotWakingPlace = { source: 'slack', placeId: 'C01', url: THREAD_URL }
const OTHER_URL = 'https://app.slack.com/client/T01/C01/thread/C01-1795415480.939339'
const OTHER: BotWakingPlace = { source: 'slack', placeId: 'C01', url: OTHER_URL }
const POST_THERE = 'post what this result settles there'
const SLACK_POST = 'orca slack post slack:T01:C01:1795415167.287389'
const UNREADABLE = 'msg_unreadable'
const HELPER_BOT = 'bot-helper'

const recordOf = (
  purpose: BotRequestPurpose,
  place?: BotWakingPlace,
  toBotId = HELPER_BOT
): BotRequestRecord => ({
  fromBotId: 'bot-desk',
  fromBotName: 'Desk',
  toBotId,
  toBotName: 'Helper',
  purpose,
  depth: 1,
  askers: [{ kind: 'owner' }],
  request: null,
  conversation: null,
  askedInConversation: 'session-desk',
  ...(place ? { originPlace: place } : {})
})

type Records = Record<string, BotRequestRecord | typeof UNREADABLE>

/** The orchestration store as the helper's host holds it: each request's record as sent, or one
 *  Orca admitted whose record no longer reads. */
const dbOf = (records: Records): OrchestrationDb =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these reads use only getBotRequest.
  ({
    getBotRequest: (id: string) => {
      const record = records[id]
      if (!record) {
        return undefined
      }
      return { record: record === UNREADABLE ? '{' : JSON.stringify(record) }
    }
  }) as unknown as OrchestrationDb

let sequence = 0
const mail = (messageIds: string[]): AgentJournalRenderItem => {
  sequence += 1
  return {
    itemId: `m${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'mail' }],
      from: {
        kind: 'agent',
        senders: [],
        orchestration: {
          message: 'mail-notice',
          mailbox: 'chat',
          dispatchId: null,
          messages: messageIds.map((messageId) => ({ messageId, runId: 'r1', from: 'desk' }))
        }
      }
    }
  }
}

/** The helper's turn over these journal rows, through Orca's record lookup. Its `originPlace` is
 *  what a request it sends carries on (bot-request-send.ts) and what an add naming no request
 *  links. */
function turnOver(records: Records, items: AgentJournalRenderItem[]): BotActingTurn {
  const db = dbOf(records)
  return readBotActingTurn(items, {
    isBotRequest: (id) => db.getBotRequest(id) !== undefined,
    botRequestActsFor: (id) => botRequestActsFor(db, id),
    conversationActsFor: [{ kind: 'owner' }],
    automationPlace: () => null,
    conversationWorkspaceId: null
  })
}

const helperTurn = (records: Records): BotActingTurn =>
  turnOver(records, [mail(Object.keys(records))])

/** Where an item the helper adds in that turn says its result goes, naming `request` or none. */
const startedIn = (records: Records, request?: string): string | null =>
  itemStartedIn(dbOf(records), HELPER_BOT, request, helperTurn(records).originPlace ?? null)

const stores: BotItemsStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function openStore(): { store: BotItemsStore; db: SyncDatabase } {
  const db = new SyncDatabase(':memory:')
  migrateBotItems(db)
  const store = new BotItemsStore(db, false)
  stores.push(store)
  return { store, db }
}

const HELPER = { kind: 'bot', botId: HELPER_BOT, chatId: 'helper-chat' } as const

/** Persists the helper's item as `bot item add` does. */
function addItem(store: BotItemsStore, place: string | null): string {
  return store.add(
    {
      ownerBotId: HELPER_BOT,
      chatId: 'helper-chat',
      source: { kind: 'home', title: null },
      title: 'Look into it',
      status: 'working',
      links: [],
      ...(place ? { startedIn: place } : {})
    },
    HELPER
  ).uid
}

/** The hint the helper reads beside its item's worker report, from the persisted item. */
async function reportHint(store: BotItemsStore, uid: string): Promise<string | null> {
  reportedUid = uid
  // The report reads only reportFact, which the real store answers directly.
  const remote: Pick<BotItemsRemote, 'reportFact'> = {
    reportFact: async (id) => store.reportFact(id)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botItemOfReport calls only store().reportFact.
  const items = { store: () => remote as BotItemsRemote }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked dispatch reads ignore both.
  const fact = await botItemOfReport(items)({} as OrchestrationDb, {} as MessageRow)
  return fact ? formatBotItemReportHint(fact) : null
}

async function hintFor(place: string | null): Promise<string | null> {
  const { store } = openStore()
  return reportHint(store, addItem(store, place))
}

describe('what a helper owes the thread a request started in', () => {
  it('a question is answered to the bot that asked it, never posted in its thread', async () => {
    const records = { msg_q: recordOf('question', THREAD) }
    const view = botRequestView(records.msg_q, 'msg_q')
    expect(view.answer).toBe('orca orchestration reply --id msg_q --body "<your answer>"')
    expect(view.answerAppears).toContain("Desk's conversation")
    expect(view.startedIn).not.toContain('--request')
    expect(helperTurn(records).originPlace).toBeUndefined()
    expect(startedIn(records)).toBeNull()
    expect(startedIn(records, 'msg_q')).toBeNull()
    const hint = await hintFor(startedIn(records, 'msg_q'))
    expect(hint).toContain('item 1')
    expect(hint).not.toContain(POST_THERE)
    expect(hint).not.toContain('slack post')
  })

  it('status asks nothing of the thread either', async () => {
    const records = { msg_s: recordOf('status', THREAD) }
    expect(helperTurn(records).originPlace).toBeUndefined()
    expect(startedIn(records)).toBeNull()
    expect(startedIn(records, 'msg_s')).toBeNull()
    expect(await hintFor(startedIn(records, 'msg_s'))).not.toContain(POST_THERE)
  })

  it('a handed-over job goes back to its thread, as its view promises', async () => {
    const records = { msg_h: recordOf('handoff', THREAD) }
    expect(botRequestView(records.msg_h, 'msg_h').startedIn).toContain(
      'Add its item with orca bot item add --request msg_h'
    )
    // Named or not, a lone handoff's item is owed its thread.
    expect(startedIn(records, 'msg_h')).toBe(THREAD_URL)
    expect(startedIn(records)).toBe(THREAD_URL)
    expect(helperTurn(records).originPlace).toEqual(THREAD)
    const hint = await hintFor(startedIn(records, 'msg_h'))
    expect(hint).toContain(`Its work started in ${THREAD_URL}: ${POST_THERE}`)
    expect(hint).toContain(SLACK_POST)
  })

  it('a result owed to a place goes there alone, so the handing bot never passes it on again', async () => {
    // A GitHub issue's handoff: no Slack post is recorded, so a full result mailed back to the
    // sender would read as unposted and be passed on a second time.
    const issue: BotWakingPlace = {
      source: 'github',
      placeId: 'acme/app#7',
      url: 'https://github.com/acme/app/issues/7'
    }
    const records = { msg_h: recordOf('handoff', issue) }
    const view = botRequestView(records.msg_h, 'msg_h')
    expect(view.startedIn).toContain('What the job finds later goes back there, not to Desk')
    expect(view.startedIn).not.toContain('the item links it')
    const hint = await hintFor(startedIn(records, 'msg_h'))
    expect(hint).toContain(`Its work started in ${issue.url}: ${POST_THERE}`)
    expect(hint).toContain(
      "Once it is posted, don't also send it to a bot that handed you this job"
    )
    // A refused post: the result is still owed, privately.
    expect(view.startedIn).toContain(
      'unless a post there is refused: then mail it to Desk as a new message, or tell your owner'
    )
    expect(hint).toContain(
      'if the post is refused, mail the result to that bot as a new message instead, or tell your owner'
    )
  })

  it('the rules promise the reports’ place, and a link only while the item has room', () => {
    const rules = botRulesSections('claude').rules
    expect(rules).toContain(
      "names that place to its workers' reports and links it while it has room for links"
    )
    expect(rules).not.toContain('links that place itself')
  })

  it('an item named for a request keeps its origin link when its own links repeat', () => {
    const repeated = Array.from({ length: BOT_ITEM_LIMITS.links }, () =>
      parseItemLink('https://example.com/a')
    )
    const links = itemLinksWithOrigin(repeated, THREAD_URL)
    expect(links.map((link) => link.ref)).toEqual(['https://example.com/a', THREAD_URL])
    // Its own distinct links at the limit stay as they are; the report still names the place.
    const full = Array.from({ length: BOT_ITEM_LIMITS.links }, (_, n) =>
      parseItemLink(`https://example.com/${n}`)
    )
    expect(itemLinksWithOrigin(full, THREAD_URL)).toHaveLength(BOT_ITEM_LIMITS.links)
    // An origin it already links, by another form of the same page, is not added twice.
    expect(itemLinksWithOrigin([parseItemLink(`${THREAD_URL}?x=1`)], THREAD_URL)).toHaveLength(1)
    expect(itemLinksWithOrigin([], null)).toEqual([])
  })

  it('beside a question or status, only the handoff’s own item is owed its thread, in either order', async () => {
    for (const other of ['question', 'status'] as const) {
      for (const place of [THREAD, OTHER, undefined]) {
        const handoff = recordOf('handoff', THREAD)
        const beside = recordOf(other, place)
        for (const records of [
          { msg_h: handoff, msg_o: beside },
          { msg_o: beside, msg_h: handoff }
        ]) {
          // The turn names no place: nothing it sends on carries one, and an add naming no
          // request (whatever it links as context) gets none.
          expect(helperTurn(records).originPlace).toBeUndefined()
          expect(startedIn(records)).toBeNull()
          // The other request's item, even when its place is the handoff's thread: none.
          expect(startedIn(records, 'msg_o')).toBeNull()
          // The handoff's item: owed its thread.
          expect(startedIn(records, 'msg_h')).toBe(THREAD_URL)
        }
      }
    }
    const records = { msg_h: recordOf('handoff', THREAD), msg_q: recordOf('question', THREAD) }
    expect(await hintFor(startedIn(records, 'msg_q'))).not.toContain(POST_THERE)
    expect(await hintFor(startedIn(records, 'msg_h'))).toContain(SLACK_POST)
  })

  it('two handoffs from two threads: each item is owed its own handoff’s thread, in either order', () => {
    const a = recordOf('handoff', THREAD)
    const b = recordOf('handoff', OTHER)
    for (const records of [
      { msg_a: a, msg_b: b },
      { msg_b: b, msg_a: a }
    ]) {
      expect(helperTurn(records).originPlace).toBeUndefined()
      expect(startedIn(records)).toBeNull()
      expect(startedIn(records, 'msg_a')).toBe(THREAD_URL)
      expect(startedIn(records, 'msg_b')).toBe(OTHER_URL)
    }
    expect(botRequestView(b, 'msg_b').startedIn).toContain('--request msg_b')
  })

  it('a stale window, an unreadable request beside it or an unreadable turn never misplace a job', () => {
    // A turn only a worker's report woke reads the handoff's older turn, but takes no place from it.
    const records = { msg_h: recordOf('handoff', THREAD) }
    expect(turnOver(records, [mail(['msg_h']), mail(['msg_report'])]).originPlace).toBeUndefined()
    // An unreadable request beside the handoff: the turn names none; the handoff's item still is owed.
    const unreadable: Records = { msg_h: recordOf('handoff', THREAD), [UNREADABLE]: UNREADABLE }
    expect(helperTurn(unreadable).originPlace).toBeUndefined()
    expect(startedIn(unreadable)).toBeNull()
    expect(startedIn(unreadable, 'msg_h')).toBe(THREAD_URL)
    // A turn that can't be read: a named handoff still reads from its own record.
    expect(itemStartedIn(dbOf(records), HELPER_BOT, 'msg_h', null)).toBe(THREAD_URL)
    expect(itemStartedIn(dbOf(records), HELPER_BOT, undefined, null)).toBeNull()
    // A handoff that started nowhere with a link owes no place.
    expect(startedIn({ msg_h: recordOf('handoff') }, 'msg_h')).toBeNull()
  })

  it('refuses a request that is not this bot’s', () => {
    const records = { msg_x: recordOf('handoff', THREAD, 'bot-someone-else') }
    expect(() => startedIn(records, 'msg_x')).toThrow(/not a request to this bot/)
    expect(() => startedIn(records, 'msg_missing')).toThrow(/not a request to this bot/)
  })

  it('a closed item’s report names no thread, even for a handoff', async () => {
    const closed: BotItemStatus[] = ['done', 'canceled']
    for (const status of closed) {
      const { store } = openStore()
      const uid = addItem(store, THREAD_URL)
      store.set(uid, { status, ...(status === 'canceled' ? { reason: 'dropped' } : {}) }, HELPER)
      expect(await reportHint(store, uid)).toBeNull()
    }
  })

  it('an item made before the marker is never told to post in its place unless that place handed over the job', async () => {
    const { store, db } = openStore()
    const uid = addItem(store, THREAD_URL)
    // As an older Orca wrote it: the place, with no word on whether the result is owed there.
    db.exec(
      "UPDATE item_events SET data = json_remove(data, '$.startedInOwed') WHERE kind = 'made'"
    )
    const hint = await reportHint(store, uid)
    expect(hint).toContain('only if that place handed you this job')
    expect(hint).toContain('give the result to whoever asked you for it (another bot by mail)')
    expect(hint).toContain('or tell your owner, never that place')
    expect(hint).not.toContain(`${THREAD_URL}: ${POST_THERE}`)
  })
})
