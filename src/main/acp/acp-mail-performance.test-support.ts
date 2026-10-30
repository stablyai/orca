import { expect, vi } from 'vitest'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { OrchestrationStructuredMailboxPointerDelivery } from '../runtime/orchestration/structured-mailbox-pointer-delivery'
import type { OrchestrationMessageWaiter } from '../runtime/orchestration/mailbox-pointer-eligibility'
import { observeMailSql } from '../runtime/orchestration/mail-handoff.test-fixture'
import { type openAttachedHostRig, message } from './acp-structured-host.test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

export function prepareMailPerformanceHistory(
  db: OrchestrationDb,
  mailbox: string,
  runId: string,
  population: number
) {
  const rows = db.insertMessages(
    Array.from({ length: population }, () => ({
      from: 'worker',
      to: mailbox,
      runId,
      subject: 'retained history'
    }))
  )
  db.markAsDelivered(
    rows.map((row) => row.id),
    mailbox
  )
  db.markAsRead(rows.map((row) => row.id))
  return { population, waiters: new Set<OrchestrationMessageWaiter>() }
}

export async function measureMailDeliveryWork(input: {
  f: Awaited<ReturnType<typeof openAttachedHostRig>>
  db: OrchestrationDb
  delivery: OrchestrationStructuredMailboxPointerDelivery<OrchestrationMessageWaiter>
  mailbox: string
  performance: ReturnType<typeof prepareMailPerformanceHistory>
}) {
  const { f, db, delivery, mailbox, performance } = input
  const journal = f.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const history = []
  for (let n = 0; n < performance.population; n++) {
    history.push(
      await journal.appendItem(
        { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId: `history-${n}` },
        message('historical output'),
        { fence: f.fence(), turnScope: { kind: 'thread' } }
      )
    )
  }
  await f.host.flushStreamedEvents(SESSION)
  await journal.readInOrder(() => undefined)
  expect(new Set(history.map((row) => row.itemId)).size).toBe(performance.population)
  expect(history.every((row) => row.revision === 1)).toBe(true)
  const calls: { sql: string; args: unknown; rows: number }[] = []
  const sql = observeMailSql(db.db, /FROM messages[\s\S]*ORDER BY sequence/, 'all', (call) => {
    calls.push({ sql: call.sql, args: call.args, rows: call.rows.length })
    expect(sql.explain(call.sql, call.args)).toContain('SEARCH')
  })
  const receipts = vi.spyOn(f.store, 'readCommandReceipt')
  for (let trigger = 0; trigger < 10; trigger++) {
    calls.length = 0
    receipts.mockClear()
    delivery.deliverForHandle(mailbox)
    await f.rig.settle()
    await journal.readInOrder(() => undefined)
    console.info('ordinary completed busy trigger', {
      population: performance.population,
      trigger,
      sourceQueries: calls,
      receipts: receipts.mock.calls
    })
    expect(calls.reduce((sum, call) => sum + call.rows, 0)).toBe(0)
    expect(receipts).not.toHaveBeenCalled()
  }
  sql.trace.mockRestore()
  receipts.mockRestore()
}
