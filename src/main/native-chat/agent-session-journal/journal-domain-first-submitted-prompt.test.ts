import { afterEach, expect, it, vi } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import {
  FIRST_SUBMITTED_PROMPT_ITEM_SQL,
  FIRST_SUBMITTED_PROMPT_SCAN_LIMIT,
  FIRST_SUBMITTED_PROMPT_SUBMISSIONS_SQL
} from './journal-domain-first-submitted-prompt'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function send(
  f: ReturnType<typeof domainLifecycleFixture>,
  id: string,
  text: string,
  submittedAt: number
) {
  await f.run({
    kind: 'submission',
    input: { clientMessageId: id, fence: 1, body: body(text), payloadFingerprint: id }
  })
  f.db
    .prepare('UPDATE journal_submission_attempts SET submitted_at=? WHERE message_id=?')
    .run(submittedAt, id)
}

function first(f: ReturnType<typeof domainLifecycleFixture>, sinceMs: number) {
  const result = readJournalSqlPoint(f.db, {
    sessionId: 'chat',
    operation: { kind: 'first-submitted-prompt', sinceMs }
  })
  return result.kind === 'first-submitted-prompt' ? result.first : undefined
}

it('applies the creation bound before taking the earliest submission', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'opener', 'Pre-creation opener', 50)
  await send(f, 'qualifying', 'Fix the login form', 110)
  expect(first(f, 100)).toMatchObject({
    kind: 'found',
    prompt: 'Fix the login form',
    submittedAt: 110
  })
})

it('orders by submission time, not journal sequence, and ignores context clears', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'sequenced-first', 'Submitted later', 300)
  await send(f, 'sequenced-second', 'Submitted earlier', 200)
  f.db
    .prepare("UPDATE journal_items SET context_clear=1 WHERE item_id LIKE '%sequenced-second%'")
    .run()
  expect(first(f, 100)).toMatchObject({
    kind: 'found',
    prompt: 'Submitted earlier',
    submittedAt: 200
  })
})

it('pages past text-less candidates to the first message with text', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index < 40; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  await send(f, 'named', 'Add password reset', 300)
  expect(first(f, 100)).toMatchObject({ kind: 'found', prompt: 'Add password reset' })
})

it('stops at the earliest valid message, whatever later history follows', async () => {
  async function submissionsVisited(laterSends: number): Promise<number> {
    const f = domainLifecycleFixture(cleanup)
    await send(f, 'first', 'Add password reset', 150)
    for (let index = 0; index < laterSends; index++) {
      await send(f, `later-${index}`, `Later request ${index}`, 300 + index)
    }
    let visited = 0
    const prepare = f.db.prepare.bind(f.db)
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (sql !== FIRST_SUBMITTED_PROMPT_SUBMISSIONS_SQL) {
        return statement
      }
      const all = statement.all.bind(statement)
      return Object.assign(statement, {
        all: (...params: Parameters<typeof all>) => {
          const rows = all(...params)
          visited += rows.length
          return rows
        }
      })
    })
    expect(first(f, 100)).toMatchObject({ kind: 'found', prompt: 'Add password reset' })
    return visited
  }
  const small = await submissionsVisited(8)
  expect(small).toBeGreaterThan(0)
  expect(await submissionsVisited(80)).toBe(small)
})

it('reports an incomplete scan when 513 unmatched submissions precede a valid one', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index <= FIRST_SUBMITTED_PROMPT_SCAN_LIMIT; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  await send(f, 'valid', 'Add password reset', 200 + FIRST_SUBMITTED_PROMPT_SCAN_LIMIT + 1)
  expect(first(f, 100)).toEqual({ kind: 'incomplete' })
})

it('matches items and aliases by keyed lookup, never by rescanning item history', () => {
  const f = domainLifecycleFixture(cleanup)
  const planOf = (sql: string, params: (string | number)[]) =>
    f.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => String(row.detail))
  // Production planner, no ANALYZE stats.
  const submissions = planOf(FIRST_SUBMITTED_PROMPT_SUBMISSIONS_SQL, ['chat', 'e', 0, 0, '', 4])
  expect(submissions).toHaveLength(1)
  expect(submissions[0]).toMatch(
    /^SEARCH journal_submission_attempts USING INDEX journal_submission_order \(session_id=\? AND epoch=\? AND \(submitted_at,ordinal,message_id\)>\(\?,\?,\?\)\)$/
  )
  const item = planOf(FIRST_SUBMITTED_PROMPT_ITEM_SQL, [
    'chat',
    'e',
    'id',
    'chat',
    'e',
    'chat',
    'e',
    'chat',
    'e',
    'id'
  ])
  expect(item.filter((detail) => detail.startsWith('SCAN '))).toEqual([])
  for (const detail of item.filter((line) => /^SEARCH i\b/.test(line))) {
    expect(detail).toMatch(/\(session_id=\? AND epoch=\? AND item_id=\?\)$/)
  }
  expect(item).toContainEqual(
    expect.stringMatching(
      /^SEARCH a USING (COVERING )?INDEX journal_item_aliases_target \(session_id=\? AND epoch=\? AND item_id=\?\)$/
    )
  )
})

it('never treats a message without a submission row as a candidate', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'orphaned', 'No submission', 150)
  f.db.prepare("DELETE FROM journal_submission_attempts WHERE message_id='orphaned'").run()
  expect(first(f, 100)).toEqual({ kind: 'none' })
})
