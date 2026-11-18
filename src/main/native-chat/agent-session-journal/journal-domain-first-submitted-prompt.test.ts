import { afterEach, expect, it } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
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

it('returns the earliest valid message even when later history follows', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'first', 'Add password reset', 150)
  for (let index = 0; index < 10; index++) {
    await send(f, `later-${index}`, `Later request ${index}`, 300 + index)
  }
  expect(first(f, 100)).toMatchObject({
    kind: 'found',
    prompt: 'Add password reset',
    submittedAt: 150
  })
})

it('reports an incomplete scan when 513 unmatched submissions precede a valid one', async () => {
  const f = domainLifecycleFixture(cleanup)
  for (let index = 0; index < 513; index++) {
    await send(f, `blank-${index}`, '', 200 + index)
  }
  await send(f, 'valid', 'Add password reset', 1000)
  expect(first(f, 100)).toEqual({ kind: 'incomplete' })
})

it('never treats a message without a submission row as a candidate', async () => {
  const f = domainLifecycleFixture(cleanup)
  await send(f, 'orphaned', 'No submission', 150)
  f.db.prepare("DELETE FROM journal_submission_attempts WHERE message_id='orphaned'").run()
  expect(first(f, 100)).toEqual({ kind: 'none' })
})
