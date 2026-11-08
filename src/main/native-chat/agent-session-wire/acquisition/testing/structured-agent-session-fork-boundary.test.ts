import { prepareForkSnapshot } from '../structured-agent-session-fork-snapshot'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readFile } from 'node:fs/promises'

import { expect, it } from 'vitest'
import { claudeConversationForkBoundary } from '../../../../claude/claude-conversation-fork-boundary'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../../../agent-session-record-test-fixture'

import { structuredAgentSessionForkBoundary } from '../structured-agent-session-fork-boundary'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId
} from '../structured-agent-session-history-catch-up'

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
      new URL('../../../../claude/__fixtures__/claude-rewind-hook.jsonl', import.meta.url),
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

it('cuts before a Claude continuation notice attributed to the next imported prompt', () => {
  const key = (uuid: string) =>
    agentJournalItemKey({ provider: 'claude', sessionId: 'source', uuid })
  const turn = (recordId: string) =>
    agentJournalItemKey({ provider: 'legacy', agent: 'claude', sessionId: 'chat', recordId })
  const snapshot: AgentJournalSnapshot = {
    sessionId: 'chat',
    cursor: { epoch: 'epoch', sequence: 6 },
    submissions: [],
    items: (
      [
        { itemId: turn('T1'), body: { kind: 'turn', turnId: 'T1', state: 'completed' } },
        {
          itemId: turn(continuedOutsideRecordId(key('answer'))),
          body: continuedOutsideNotice(false),
          turnScope: { kind: 'thread' }
        },
        {
          itemId: key('answer'),
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'FOXTROT' }] },
          turnScope: { kind: 'turn', turnItemId: turn('T1') }
        },
        {
          itemId: turn(continuedOutsideRecordId(key('late-detail'))),
          body: continuedOutsideNotice(false),
          turnScope: { kind: 'thread' }
        },
        {
          itemId: turn(continuedOutsideRecordId(key('terminal-user'))),
          body: continuedOutsideNotice(false),
          turnScope: { kind: 'thread' }
        },
        {
          itemId: turn('T2'),
          body: { kind: 'turn', turnId: 'T2', state: 'completed', userItemId: key('terminal-user') }
        },
        {
          itemId: key('terminal-user'),
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'later terminal prompt' }]
          },
          turnScope: { kind: 'turn', turnItemId: turn('T2') }
        },
        {
          itemId: key('late-detail'),
          body: { kind: 'status', text: 'retained detail' },
          turnScope: { kind: 'turn', turnItemId: turn('T1') }
        }
      ] satisfies Omit<
        AgentJournalSnapshot['items'][number],
        'sequence' | 'revision' | 'observedAt'
      >[]
    ).map((item, index) => ({
      ...item,
      sequence: index + 1,
      revision: 1,
      observedAt: 123
    }))
  }
  expect(
    prepareForkSnapshot({ snapshot, nextItemId: turn('T2') }).map((item) =>
      agentJournalItemKey(item.identity)
    )
  ).toEqual([
    'legacy:claude:chat:T1',
    'legacy:claude:chat:continued-outside%3Aclaude%3Asource%3Aanswer',
    'claude:source:answer',
    'legacy:claude:chat:continued-outside%3Aclaude%3Asource%3Alate-detail',
    'claude:source:late-detail'
  ])
})
