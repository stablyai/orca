import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { StructuredAgentSessionTransition } from '../structured-agent-session-transition'

import {
  identity,
  itemStep,
  rig,
  tool
} from './structured-agent-session-transition-contract.test-fixture'

it('lands its steps back to back, each resolved after the one before it', async () => {
  const { journal, deferred, sink, publishes, bind } = await rig()
  bind()
  const turn = identity('turn-lifecycle:turn-1')
  const running = { kind: 'turn' as const, turnId: 'turn-1', state: 'running' as const }
  const window = { tokens: 200_000, capturedAt: 2 }
  const transition: StructuredAgentSessionTransition = {
    lifecycle: false,
    publish: true,
    steps: [
      itemStep({ kind: 'turn-open', identity: turn, body: running }),
      // A context revision writes only onto a row that exists when it resolves.
      itemStep({
        kind: 'turn-row',
        target: { identity: turn },
        write: { contextUsage: { window } }
      })
    ]
  }
  expect(sink.tryAppendTransition?.(transition)).toEqual({ accepted: true })
  sink.tryAppendItem?.(identity('later'), tool('later', 'running'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await deferred.drained()

  const items = await readTestJournalItems(journal)
  expect(items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(turn),
    agentJournalItemKey(identity('later'))
  ])
  expect(items[0]?.body).toEqual({ ...running, contextUsage: { window } })
  expect(items[0]?.revision).toBe(2)
  expect(publishes).toHaveLength(1)
})

it('writes nothing after a step whose row the database refused', async () => {
  const { root, journal, deferred, sink, bind } = await rig()
  bind()
  // Fail step two to verify step three never fills its place.
  await withTestAgentSessionDatabase(root, (db) =>
    db.exec(`CREATE TRIGGER fail_second_step
BEFORE INSERT ON journal_items WHEN instr(NEW.payload_json, 'refused-step') > 0
BEGIN SELECT RAISE(ABORT, 'second step refused'); END`)
  )
  const step = (recordId: string) =>
    itemStep({ kind: 'literal', identity: identity(recordId), body: tool(recordId, 'running') })
  sink.tryAppendTransition?.({
    lifecycle: false,
    publish: true,
    steps: [step('first'), step('refused-step'), step('third')]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect((await readTestJournalItems(journal)).map((item) => item.itemId)).toEqual([
    agentJournalItemKey(identity('first'))
  ])
})
