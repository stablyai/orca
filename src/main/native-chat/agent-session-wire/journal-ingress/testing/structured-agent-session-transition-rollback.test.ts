import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

import {
  failedTool,
  identity,
  itemStep,
  rig,
  tool
} from './structured-agent-session-transition-contract-test-fixture'

it('leaves no row of a settlement durable when a later one of its rows fails to write', async () => {
  const { root, journal, deferred, sink, bind } = await rig()
  bind()
  const running = Array.from({ length: 250 }, (_, index) => identity(`tool-${index}`))
  for (const id of running) {
    sink.tryAppendItem?.(id, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  }
  await deferred.drained()
  const before = journal.cursor().sequence
  // Abort the second insert to verify settlement transaction atomicity.
  openTestJournalHostDatabase(root).db.exec(`CREATE TEMP TRIGGER fail_second_chunk
BEFORE INSERT ON main.journal_rows WHEN NEW.seq = ${before + 2}
BEGIN SELECT RAISE(ABORT, 'second chunk refused'); END`)
  sink.tryAppendTransition?.({
    lifecycle: true,
    publish: true,
    steps: [
      {
        kind: 'settlement',
        settlementId: 'settle-all',
        reservedBytes: 1,
        resolve: () => running.map(failedTool)
      }
    ]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.cursor().sequence).toBe(before)
  expect(
    journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
  ).toEqual([])
})

it('lands a write a step issues while it runs after the whole transition', async () => {
  const { journal, deferred, sink, bind } = await rig()
  bind()
  sink.tryAppendTransition?.({
    lifecycle: false,
    publish: false,
    steps: [
      itemStep(() => {
        // Nested writes must wait until the whole transition finishes.
        sink.tryAppendItem?.(identity('nested'), tool('nested', 'running'), {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
        return { identity: identity('first'), body: tool('first', 'running') }
      }),
      itemStep(() => ({ identity: identity('second'), body: tool('second', 'running') }))
    ]
  })
  await deferred.drained()

  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
    ['first', 'second', 'nested'].map((recordId) => agentJournalItemKey(identity(recordId)))
  )
})
