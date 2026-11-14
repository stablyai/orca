import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'

import {
  failedTool,
  identity,
  rig,
  tool
} from './structured-agent-session-transition-contract.test-fixture'

it('leaves no row of a settlement durable when a later one of its rows fails to write', async () => {
  const { root, journal, deferred, sink, bind } = await rig()
  bind()
  const running = [identity('tool-0'), identity('tool-1')]
  for (const id of running) {
    sink.tryAppendItem?.(id, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  }
  await deferred.drained()
  const before = journal.cursor().sequence
  await withTestAgentSessionDatabase(root, (db) =>
    db.exec(`CREATE TRIGGER fail_settlement
BEFORE UPDATE ON journal_items WHEN NEW.item_id = '${agentJournalItemKey(running[1]!)}'
BEGIN SELECT RAISE(ABORT, 'settlement refused'); END`)
  )
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
