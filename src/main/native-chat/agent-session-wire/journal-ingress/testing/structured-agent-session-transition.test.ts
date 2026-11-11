import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionTransition } from '../structured-agent-session-transition'

import {
  identity,
  itemStep,
  rig,
  tool
} from './structured-agent-session-transition-contract-test-fixture'

it('lands its steps back to back, each resolved after the one before it', async () => {
  const { journal, deferred, sink, publishes, bind } = await rig()
  bind()
  const first = identity('first')
  const transition: StructuredAgentSessionTransition = {
    lifecycle: false,
    publish: true,
    steps: [
      itemStep(() => ({ identity: first, body: tool('read', 'running') })),
      itemStep((view) => {
        const before = view.itemBody(agentJournalItemKey(first))
        return before?.kind === 'tool-call'
          ? { identity: identity('second'), body: tool(`after-${before.name}`, 'running') }
          : null
      })
    ]
  }
  expect(sink.tryAppendTransition?.(transition)).toEqual({ accepted: true })
  sink.tryAppendItem?.(identity('later'), tool('later', 'running'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await deferred.drained()

  const items = journal.snapshot().items
  const start = items[0]?.sequence ?? 0
  expect(items.map((item) => [item.itemId, item.sequence - start])).toEqual([
    [agentJournalItemKey(first), 0],
    [agentJournalItemKey(identity('second')), 1],
    [agentJournalItemKey(identity('later')), 2]
  ])
  expect(items[1]?.body).toMatchObject({ name: 'after-read' })
  expect(publishes).toHaveLength(1)
})

it('writes nothing after a step whose row the database refused', async () => {
  const { root, journal, deferred, sink, bind } = await rig()
  bind()
  // Fail step two to verify step three never fills its place.
  openTestJournalHostDatabase(root).db.exec(`CREATE TEMP TRIGGER fail_second_step
BEFORE INSERT ON main.journal_rows WHEN instr(NEW.row_json, 'refused-step') > 0
BEGIN SELECT RAISE(ABORT, 'second step refused'); END`)
  const step = (recordId: string) =>
    itemStep(() => ({ identity: identity(recordId), body: tool(recordId, 'running') }))
  sink.tryAppendTransition?.({
    lifecycle: false,
    publish: true,
    steps: [step('first'), step('refused-step'), step('third')]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(identity('first'))
  ])
})
