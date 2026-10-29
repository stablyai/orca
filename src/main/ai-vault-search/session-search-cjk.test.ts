import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_SEARCH_SNIPPET_MARK_CLOSE,
  SESSION_SEARCH_SNIPPET_MARK_OPEN
} from './session-search-engine-types'
import { hasCjkText, planSessionSearchQuery } from './session-search-query-planner'
import {
  addSyntheticSession,
  openSessionSearchHarness,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'
import { deleteSearchMessages } from './session-search-message-rows'

let harness: SessionSearchHarness | null = null

afterEach(async () => {
  await harness?.close()
  harness = null
})

// The sentences from issue #28256: unicode61 indexes each run between `，`/`。` as one token.
const SENTENCE = '它会把删除暂存进索引。按仓库约定，然后提交'

async function open(): Promise<SessionSearchHarness> {
  harness = await openSessionSearchHarness('ss-cjk')
  return harness
}

describe('CJK query planning', () => {
  it('finds the CJK runs and leaves the other tokens for the main index', () => {
    const plan = planSessionSearchQuery('删除暂存 index 仓库')
    expect(plan.cjkRuns).toEqual(['删除暂存', '仓库'])
    expect(plan.cjkRest).toEqual(['index'])
  })

  it('treats kana, the prolonged sound mark and Hangul as CJK, and Latin as not', () => {
    expect(hasCjkText('サーバー')).toBe(true)
    expect(hasCjkText('ひらがな')).toBe(true)
    expect(hasCjkText('한국어')).toBe(true)
    expect(hasCjkText('plain ascii é')).toBe(false)
    expect(planSessionSearchQuery('plain ascii').cjkRuns).toEqual([])
  })
})

describe('a CJK query matches any substring of a longer run', () => {
  it.each([
    ['the whole run', '它会把删除暂存进索引'],
    ['a prefix', '它会把删除'],
    ['the middle', '删除暂存'],
    ['a suffix', '暂存进索引'],
    ['another run', '仓库约定'],
    ['a two-character word', '删除'],
    ['a single character', '索']
  ])('finds %s', async (_name, query) => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: SENTENCE })
    addSyntheticSession(db, { id: 2, text: 'unrelated english text' })
    const result = engine.search({ query })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
  })

  it('requires every CJK run and every other token of the query', async () => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: `${SENTENCE} the index is staged` })
    addSyntheticSession(db, { id: 2, text: SENTENCE })
    expect(engine.search({ query: '删除暂存 仓库约定' }).hits).toHaveLength(2)
    expect(engine.search({ query: '删除暂存 提交仓库' }).hits).toHaveLength(0)
    expect(engine.search({ query: '删除暂存 staged' }).hits.map((hit) => hit.sessionId)).toEqual([
      '1'
    ])
  })

  it('keeps a conversation search out of tool output but lets the all scope in', async () => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: 'hello', toolText: '工具输出里的删除暂存' })
    expect(engine.search({ query: '删除暂存', scope: 'conversation' }).hits).toHaveLength(0)
    expect(engine.search({ query: '删除暂存', scope: 'all' }).hits).toHaveLength(1)
  })

  it('marks the matched text in the snippet', async () => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: SENTENCE })
    for (const query of ['删除暂存', '删除']) {
      const [hit] = engine.search({ query }).hits
      expect(hit?.evidence?.snippet).toContain(
        `${SESSION_SEARCH_SNIPPET_MARK_OPEN}${query}${SESSION_SEARCH_SNIPPET_MARK_CLOSE}`
      )
    }
  })

  it('still answers Latin queries from the main index', async () => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: `${SENTENCE} marmoset` })
    const result = engine.search({ query: 'marmoset' })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['1'])
    expect(result.planner.route).toBe('or')
  })
})

describe('the CJK index follows the rows it mirrors', () => {
  const cjkRows = (db: SessionSearchHarness['db']): number =>
    Number(db.prepare('SELECT count(*) AS n FROM messages_cjk_fts').get()?.n)

  it('holds only rows that contain CJK text', async () => {
    const { db } = await open()
    addSyntheticSession(db, { id: 1, text: SENTENCE })
    addSyntheticSession(db, { id: 2, text: 'english only' })
    expect(cjkRows(db)).toBe(1)
  })

  it('drops the rows of a session when its messages are deleted', async () => {
    const { db, engine } = await open()
    addSyntheticSession(db, { id: 1, text: SENTENCE, rows: 3 })
    expect(cjkRows(db)).toBe(3)
    deleteSearchMessages(db, 1)
    expect(cjkRows(db)).toBe(0)
    expect(engine.search({ query: '删除暂存' }).hits).toHaveLength(0)
  })
})
