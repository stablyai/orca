import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { forkSession, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { prepareLegacyTranscriptImport } from '../agent-session-journal/journal-legacy-import'
import capture from '../../claude/__fixtures__/claude-plugin-recovery.json'
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

it.each([false, true])(
  'cuts a Claude fork at a recorded task wake, retaining caller-owned results: %s',
  async (mixed) => {
    const opener = {
      ...capture[0]!,
      uuid: 'prompt',
      parentUuid: null,
      origin: { kind: 'human' },
      message: { role: 'user', content: 'original request' }
    }
    const answer = {
      ...capture[1]!,
      uuid: 'answer',
      parentUuid: 'prompt',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'original response' },
          ...(mixed
            ? [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'original' } }]
            : [])
        ],
        stop_reason: mixed ? 'tool_use' : 'end_turn'
      }
    }
    const wake = {
      ...capture[0]!,
      parentUuid: 'answer',
      ...(mixed
        ? {
            message: {
              role: 'user',
              content: [
                { type: 'text', text: String(capture[0]!.message.content) },
                { type: 'tool_result', tool_use_id: 'toolu_1', content: 'real result' }
              ]
            }
          }
        : {})
    }
    const following = { ...answer, uuid: 'wake-answer', parentUuid: wake.uuid }
    const entries = [opener, answer, wake, following]
    const checkpoint = {
      selectedItemId: 'response',
      settled: true,
      rootMessage: { sessionId: opener.sessionId, uuid: 'prompt' },
      throughMessage: { sessionId: opener.sessionId, uuid: 'answer' }
    }
    const endpoint = claudeConversationForkBoundary(entries, checkpoint)
    expect(endpoint).toBe(mixed ? wake.uuid : 'answer')
    expect(claudeConversationForkBoundary(entries, { ...checkpoint, rootMessage: undefined })).toBe(
      mixed ? wake.uuid : 'answer'
    )
    expect(
      claudeConversationForkBoundary(entries, {
        ...checkpoint,
        beforeMessage: { sessionId: opener.sessionId, uuid: wake.uuid }
      })
    ).toBe(mixed ? wake.uuid : 'answer')
    const copied: SessionStoreEntry[] = []
    const result = await forkSession(opener.sessionId, {
      upToMessageId: endpoint,
      sessionStore: {
        load: async () => entries,
        append: async (_key, rows) => {
          copied.push(...rows)
        }
      }
    })
    // The SDK remaps uuids but records each copied row's source uuid, so the
    // independent wake answer must not appear anywhere in the copy.
    expect(copied.some((row) => JSON.stringify(row).includes('"wake-answer"'))).toBe(false)
    const path = join(fixture.root, 'fork.jsonl')
    await writeFile(path, `${copied.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: result.sessionId,
      options: { filePath: path }
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      throw new Error(prepared.error)
    }
    expect(
      prepared.items.filter((row) => row.body.kind === 'message' && row.body.role === 'user')
    ).toHaveLength(1)
    expect(JSON.stringify(prepared.items)).not.toContain('<task-notification>')
    if (mixed) {
      expect(prepared.items.at(-1)?.body).toMatchObject({
        kind: 'message',
        role: 'tool',
        blocks: [{ type: 'tool-result', callId: 'toolu_1', output: 'real result' }]
      })
    }
  }
)
