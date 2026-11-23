import { describe, expect, it } from 'vitest'
import type { AgentReadEntry } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalPage, type AgentReadJournalPage } from '../agent-read-journal-page'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../agent-session-history-page-bounds'
import { body, fixture, item } from './agent-session-history-contract.test-fixture'

const ORCA_ID = 'orca-root-1'
let ordinal = 0
let batches = 0

const appendBody = (content: AgentJournalItemBody) =>
  fixture.journal.appendItem(item(++ordinal), content, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
const say = (text: string) => appendBody(body(text))
const think = (text: string) =>
  appendBody({ kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text }] })
/** Entries one lifecycle write places in a single journal sequence. */
const sayInOneSequence = (texts: readonly string[]) =>
  fixture.journal.appendLifecycleBatch({
    settlementId: `batch-${++batches}`,
    fence: 1,
    mutations: texts.map((text) => ({
      kind: 'item' as const,
      identity: item(++ordinal),
      body: body(text),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
  })
/** An entry of about `share` of a page's byte budget. */
const large = (id: string, share: number) =>
  `${id} ${'x'.repeat(Math.floor(HISTORY_PAGE_CONTENT_BUDGET_BYTES * share))}`

function readPage(
  limit: number,
  cursor?: string,
  { orcaSessionId = ORCA_ID, sessionId = 'session-1' } = {}
): Promise<AgentReadJournalPage> {
  return readAgentJournalPage(
    fixture.journal,
    { orcaSessionId, sessionId, limit, ...(cursor !== undefined ? { cursor } : {}) },
    () => true
  )
}

/** Every page from the newest to the one with no cursor; `between` runs after each page. */
async function readEveryPage(
  limit: number,
  between?: () => Promise<unknown>
): Promise<AgentReadJournalPage[]> {
  const pages: AgentReadJournalPage[] = []
  let cursor: string | undefined
  while (pages.length < 100) {
    const page = await readPage(limit, cursor)
    pages.push(page)
    if (page.nextCursor === null) {
      return pages
    }
    cursor = page.nextCursor
    await between?.()
  }
  throw new Error('paging did not end')
}

const idOf = (entry: AgentReadEntry) => (entry.kind === 'message' ? entry.text.split(' ')[0] : '')
const assembled = (pages: readonly AgentReadJournalPage[]) =>
  pages.toReversed().flatMap((page) => page.entries.map(idOf))
const editCursor = (cursor: string, change: Record<string, unknown>) => {
  const payload = JSON.parse(Buffer.from(cursor.slice('oar1_'.length), 'base64url').toString())
  return `oar1_${Buffer.from(JSON.stringify({ ...payload, ...change })).toString('base64url')}`
}

describe('readAgentJournalPage', () => {
  it('pages back to the start with every entry once, in order, while the chat goes on', async () => {
    ordinal = 0
    const ids: string[] = []
    for (let index = 0; index < 26; index++) {
      if (index % 5 === 0) {
        await think(`thought${index}`)
      }
      ids.push(`e${index}`)
      await say(index >= 10 && index < 14 ? large(`e${index}`, 0.3) : `e${index}`)
    }
    let added = 0
    const pages = await readEveryPage(4, () => say(`new${added++}`))

    expect(assembled(pages)).toEqual(ids)
    // The byte budget, not the limit, ended a page of the large entries.
    expect(pages.some((page) => page.nextCursor && page.entries.length < 4)).toBe(true)
    expect((await readPage(2)).entries.map(idOf)).toEqual([`new${added - 2}`, `new${added - 1}`])
  })

  it('shows each entry of one journal sequence once when the limit splits it', async () => {
    ordinal = 0
    await say('a0')
    await sayInOneSequence(['g0', 'g1', 'g2', 'g3', 'g4'])
    await say('a1')
    const pages = await readEveryPage(2)

    expect(pages.map((page) => page.entries.map(idOf))).toEqual([
      ['g4', 'a1'],
      ['g2', 'g3'],
      ['g0', 'g1'],
      ['a0']
    ])
  })

  it('pages entries near half the byte budget without stalling', async () => {
    ordinal = 0
    const ids = Array.from({ length: 7 }, (_, index) => `big${index}`)
    for (const id of ids) {
      await say(large(id, 0.45))
    }
    const pages = await readEveryPage(20)

    expect(assembled(pages)).toEqual(ids)
    expect(pages.every((page) => page.entries.length > 0)).toBe(true)
  })

  it('refuses a cursor as stale once the epoch or the running session changed', async () => {
    ordinal = 0
    for (let index = 0; index < 6; index++) {
      await say(`e${index}`)
    }
    const cursor = (await readPage(2)).nextCursor!
    await expect(readPage(2, cursor, { sessionId: 'session-2' })).rejects.toMatchObject({
      code: 'agent_cursor_stale'
    })
    await fixture.journal.write({
      kind: 'epoch-replace',
      reason: 'handle_forked',
      fence: 1,
      items: []
    })
    await expect(readPage(2, cursor)).rejects.toMatchObject({ code: 'agent_cursor_stale' })
  })

  it('refuses a cursor that was never valid for this chat', async () => {
    ordinal = 0
    for (let index = 0; index < 6; index++) {
      await say(`e${index}`)
    }
    const foreign = (await readPage(2, undefined, { orcaSessionId: 'other-root' })).nextCursor!
    const own = (await readPage(2)).nextCursor!

    for (const cursor of [
      foreign,
      editCursor(own, { k: 'terminal' }),
      editCursor(own, { v: 2 }),
      editCursor(own, { a: [1, 0] }),
      'oar1_%%%',
      `${own}${'A'.repeat(4_096)}`
    ]) {
      await expect(readPage(2, cursor)).rejects.toMatchObject({ code: 'agent_cursor_invalid' })
    }
    expect((await readPage(2, own)).entries.map(idOf)).toEqual(['e2', 'e3'])
  })
})
