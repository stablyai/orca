import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { fixture, appendItems, item } from './agent-session-history-contract-test-fixture'
import { structuredAgentSessionForkBoundary } from './structured-agent-session-fork-boundary'

it('allows the last inherited response without a new turn and rejects responses removed by rewind', async () => {
  await appendItems(2)
  const selected = agentJournalItemKey(item(2))
  const record = agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'codex',
    forkedFrom: {
      sessionId: 'parent',
      itemId: 'source',
      childBoundary: { kind: 'item', itemId: selected }
    }
  })
  expect(
    structuredAgentSessionForkBoundary(fixture.journal.snapshot(), record, selected)
  ).toMatchObject({ latest: true, checkpoint: { turnId: 'turn-1', settled: true } })
  await fixture.journal.replaceEpochItems('handle_forked', 1, [])
  expect(
    structuredAgentSessionForkBoundary(fixture.journal.snapshot(), record, selected)
  ).toBeNull()
})

it('does not treat the presence of saved assistant content as completion of an unresolved root', async () => {
  await appendItems(1)
  const record = agentSessionRecordFixture({ sessionId: 'session-1' })
  expect(
    structuredAgentSessionForkBoundary(
      fixture.journal.snapshot(),
      record,
      agentJournalItemKey(item(1))
    )?.checkpoint.settled
  ).toBe(false)
})

it('carries a settled root opener even when the streamed block never acquired a final native row', () => {
  const opener = agentJournalItemKey({
    provider: 'claude',
    sessionId: 'native-source',
    uuid: 'prompt-1'
  })
  const selected = agentJournalItemKey({
    provider: 'claude',
    sessionId: 'native-source',
    uuid: 'block:msg_lost:0'
  })
  const boundary = structuredAgentSessionForkBoundary(
    {
      sessionId: 'source',
      cursor: { epoch: 'epoch', sequence: 3 },
      submissions: [],
      items: [
        {
          itemId: opener,
          sequence: 1,
          revision: 0,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
        },
        {
          itemId: 'root',
          sequence: 2,
          revision: 1,
          observedAt: 2,
          body: { kind: 'turn', turnId: 'root', userItemId: opener, state: 'interrupted' }
        },
        {
          itemId: selected,
          sequence: 3,
          revision: 1,
          observedAt: 3,
          turnScope: { kind: 'turn', turnItemId: 'root' },
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] }
        }
      ]
    },
    agentSessionRecordFixture({ sessionId: 'source', provider: 'claude' }),
    selected
  )
  expect(boundary?.checkpoint).toMatchObject({
    settled: true,
    rootMessage: { sessionId: 'native-source', uuid: 'prompt-1' }
  })
})
