import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { claudeConversationForkBoundary } from '../../claude/claude-conversation-fork-boundary'
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

it('cuts Claude forks before a local-command caveat following the response', async () => {
  const rows = (
    await readFile(
      new URL('../../claude/__fixtures__/claude-rewind-hook.jsonl', import.meta.url),
      'utf8'
    )
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const row = (uuid: string, parentUuid: string, content: string, isMeta?: true) => ({
    ...rows[54],
    uuid,
    parentUuid,
    isMeta,
    message: { role: 'user', content }
  })
  const caveat = row(
    'caveat',
    'ef5b13f9-6a3f-5d82-8452-cb799862efc0',
    '<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>',
    true
  )
  const command = row('command', caveat.uuid, '<command-name>/usage</command-name>')
  const stdout = row('stdout', command.uuid, '<local-command-stdout>ok</local-command-stdout>')
  const entries = [...rows.slice(0, 48), caveat, command, stdout]
  const checkpoint = {
    selectedItemId: 'response',
    settled: true,
    throughMessage: { sessionId: 'source', uuid: 'ef5b13f9-6a3f-5d82-8452-cb799862efc0' }
  }
  expect(claudeConversationForkBoundary(entries, checkpoint)).toBe(
    'ef5b13f9-6a3f-5d82-8452-cb799862efc0'
  )
  expect(
    claudeConversationForkBoundary(entries, {
      ...checkpoint,
      beforeMessage: { sessionId: 'source', uuid: command.uuid }
    })
  ).toBe('ef5b13f9-6a3f-5d82-8452-cb799862efc0')
})
