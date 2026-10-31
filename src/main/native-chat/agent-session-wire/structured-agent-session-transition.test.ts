import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionTransition } from './structured-agent-session-transition'

import {
  failedTool,
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

it('admitted whole is not executed whole: a failed step keeps the ones before it and fails the sink', async () => {
  const { journal, deferred, sink, publishes, bind } = await rig()
  bind()
  sink.tryAppendTransition?.({
    lifecycle: false,
    publish: true,
    steps: [
      itemStep(() => ({ identity: identity('kept'), body: tool('read', 'running') })),
      itemStep(() => {
        throw new Error('resolver failed')
      })
    ]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(identity('kept'))
  ])
  expect(publishes).toEqual([])
  expect(
    sink.tryAppendTransition?.({
      lifecycle: false,
      publish: false,
      steps: [itemStep(() => null)]
    })
  ).toEqual({ accepted: false, reason: 'failed' })
})

it('writes nothing after a step that overflows its reservation', async () => {
  const { journal, deferred, sink, publishes, bind } = await rig()
  bind()
  const after = vi.fn(() => ({ identity: identity('third'), body: tool('read', 'running') }))
  sink.tryAppendTransition?.({
    lifecycle: false,
    publish: true,
    steps: [
      itemStep(() => ({ identity: identity('first'), body: tool('read', 'running') })),
      itemStep(
        () => ({ identity: identity('second'), body: tool('x'.repeat(10_000), 'running') }),
        64
      ),
      itemStep(after)
    ]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(identity('first'))
  ])
  expect(after).not.toHaveBeenCalled()
  expect(publishes).toEqual([])
})

it('opens no next-turn work after a settlement the journal refused', async () => {
  const { journal, deferred, sink, bind } = await rig()
  bind()
  const old = identity('old-tool')
  sink.tryAppendItem?.(old, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  await deferred.drained()
  sink.tryAppendTransition?.({
    lifecycle: true,
    publish: true,
    steps: [
      itemStep(() => ({ identity: identity('before'), body: tool('read', 'completed') })),
      {
        kind: 'settlement',
        settlementId: 'settle',
        reservedBytes: 1,
        resolve: () => [failedTool(old), failedTool(old)]
      },
      itemStep(() => ({ identity: identity('next-turn-work'), body: tool('read', 'running') }))
    ]
  })

  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(old),
    agentJournalItemKey(identity('before'))
  ])
  expect(journal.item(agentJournalItemKey(old))?.body).toMatchObject({ state: 'running' })
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

it('refuses a transition whole, so none of its steps ever lands', async () => {
  const { journal, deferred, sink, bind } = await rig({ maxQueuedOperations: 1 })
  const step = (recordId: string) =>
    itemStep(() => ({ identity: identity(recordId), body: tool(recordId, 'running') }))
  const admitted = { lifecycle: false, publish: false, steps: [step('a')] }
  const refused = { lifecycle: false, publish: false, steps: [step('b'), step('c')] }

  expect(sink.tryAppendTransition?.(admitted)).toEqual({ accepted: true })
  expect(sink.tryAppendTransition?.(refused)).toEqual({
    accepted: false,
    reason: 'backpressure'
  })
  bind()
  await deferred.drained()

  expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
    agentJournalItemKey(identity('a'))
  ])
})

it('settles from the rows as they stand, in consecutive rows when one cannot hold them', async () => {
  const { journal, deferred, sink, publishes, bind } = await rig()
  bind()
  const running = Array.from({ length: 250 }, (_, index) => identity(`tool-${index}`))
  for (const id of running) {
    sink.tryAppendItem?.(id, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  }
  sink.tryAppendItem?.(identity('done'), tool('read', 'completed'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(
    sink.tryAppendTransition?.({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: 'settle-all',
          reservedBytes: 1,
          // Include an already-settled candidate so the fold must exclude it.
          resolve: (view) =>
            [...running, identity('done')].flatMap((id) => {
              const body = view.itemBody(agentJournalItemKey(id))
              return body?.kind === 'tool-call' && body.state === 'running'
                ? [
                    {
                      kind: 'item' as const,
                      identity: id,
                      body: { ...body, state: 'failed' as const },
                      turnScope: AGENT_JOURNAL_THREAD_SCOPE
                    }
                  ]
                : []
            })
        }
      ]
    })
  ).toEqual({ accepted: true })
  sink.tryAppendItem?.(identity('after'), tool('after', 'running'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await deferred.drained()

  const items = journal.snapshot().items
  const sequenceOf = (recordId: string) =>
    items.find((item) => item.itemId === agentJournalItemKey(identity(recordId)))?.sequence ?? 0
  expect(
    items.filter((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
  ).toHaveLength(250)
  expect(
    items.find((item) => item.itemId === agentJournalItemKey(identity('done')))?.body
  ).toMatchObject({ state: 'completed' })
  expect(sequenceOf('after') - sequenceOf('done')).toBe(3)
  expect(publishes).toHaveLength(1)
})
