import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

import {
  failedTool,
  identity,
  rig,
  tool
} from './structured-agent-session-transition-contract.test-fixture'

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
        resolution: { kind: 'turn-revisions', mutations: running.map(failedTool), keptBytes: 0 }
      }
    ]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.cursor().sequence).toBe(before)
  expect(
    (await readTestJournalItems(journal)).filter(
      (item) => item.body.kind === 'tool-call' && item.body.state === 'failed'
    )
  ).toEqual([])
})
