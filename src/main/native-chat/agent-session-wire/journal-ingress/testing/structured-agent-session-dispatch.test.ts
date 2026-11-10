import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  failedTool,
  identity,
  rig,
  tool
} from './structured-agent-session-transition-contract.test-fixture'

const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }

it.each(['step threshold', 'byte threshold'] as const)(
  'publishes a terminal turn and trailing output together across the %s despite two publish calls',
  async (threshold) => {
    const { journal, deferred, sink, bind } = await rig()
    bind()
    const batches: AgentJournalRenderItem[][] = []
    journal.observeCommits((commit) => batches.push(commit.publication?.items ?? []))
    if (threshold === 'step threshold') {
      for (let index = 0; index < 63; index++) {
        sink.appendItem(identity(`filler-${index}`), tool('read', 'completed'), options)
      }
    } else {
      sink.appendItem(
        identity('large-output'),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'x'.repeat(1_048_576) }]
        },
        options
      )
    }
    sink.appendItem(
      identity('turn'),
      { kind: 'turn', turnId: 'turn-1', state: 'completed' },
      options
    )
    sink.publish({ coalescingKey: 'turn' })
    sink.appendItem(
      identity('fallback'),
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Exact final output' }]
      },
      options
    )
    sink.publish()
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(
      batches.map((batch) =>
        batch.filter(
          (item) =>
            item.body.kind === 'turn' || item.itemId === agentJournalItemKey(identity('fallback'))
        )
      )
    ).toEqual([
      [
        expect.objectContaining({ body: { kind: 'turn', turnId: 'turn-1', state: 'completed' } }),
        expect.objectContaining({
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Exact final output' }]
          }
        })
      ]
    ])
  }
)

it('commits unpublished observations and resumes paused reading without a later frame or barrier', async () => {
  let resume!: () => void
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  const { journal, sink, bind } = await rig({
    watermarks: { pauseQueuedOperations: 2, lowQueuedOperations: 0 },
    readingControl: { pauseReading() {}, resumeReading: () => resume() }
  })
  bind()
  sink.appendItem(identity('silent-a'), tool('a', 'completed'), options)
  sink.appendItem(identity('silent-b'), tool('b', 'completed'), options)
  await resumed
  expect((await readTestJournalItems(journal)).map((item) => item.body)).toEqual([
    tool('a', 'completed'),
    tool('b', 'completed')
  ])
})

it('hands off admitted work to the old journal on unbind and to the bound journal on close', async () => {
  const first = await rig()
  const second = await rig()
  first.bind()
  first.sink.appendItem(identity('old'), tool('old', 'completed'), options)
  first.deferred.unbind()
  first.deferred.bind({ journal: second.journal, fence: 2, publish() {} })
  first.sink.appendItem(identity('new'), tool('new', 'completed'), options)
  first.deferred.close()
  await expect(first.sink.written?.()).resolves.toEqual({ ok: true })
  expect((await readTestJournalItems(first.journal)).map((item) => item.body)).toEqual([
    tool('old', 'completed')
  ])
  expect((await readTestJournalItems(second.journal)).map((item) => item.body)).toEqual([
    tool('new', 'completed')
  ])
})

it('publishes the committed prefix while rolling back the entire failed lifecycle and skipping the suffix', async () => {
  const { root, journal, deferred, sink, bind, publishes } = await rig()
  bind()
  await withTestAgentSessionDatabase(root, (db) =>
    db.exec(`CREATE TRIGGER refuse_lifecycle_member
    BEFORE INSERT ON journal_items WHEN instr(NEW.payload_json, 'refused') > 0
    BEGIN SELECT RAISE(ABORT, 'lifecycle refused'); END`)
  )
  const batches: AgentJournalRenderItem[][] = []
  journal.observeCommits((commit) => batches.push(commit.publication?.items ?? []))
  sink.appendItem(identity('first'), tool('first', 'completed'), options)
  sink.tryAppendLifecycleBatch?.('failed-lifecycle', [
    failedTool(identity('rolled-back')),
    failedTool(identity('refused'))
  ])
  sink.appendItem(identity('suffix'), tool('suffix', 'completed'), options)
  sink.publish()
  await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
  expect(batches.map((batch) => batch.map((item) => item.body))).toEqual([
    [tool('first', 'completed')]
  ])
  expect((await readTestJournalItems(journal)).map((item) => item.body)).toEqual([
    tool('first', 'completed')
  ])
  expect(publishes).toEqual([1])
})
