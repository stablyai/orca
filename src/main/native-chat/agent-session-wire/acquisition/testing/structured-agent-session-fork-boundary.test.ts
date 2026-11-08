import { acpHistoryTurns } from '../../../../acp/history/acp-history-replay'
import { translateHistoryTurn } from '../../../../acp/history/acp-history-translation'
import { OPENCODE_ACP_DIALECT } from '../../../../acp/acp-dialects/opencode-dialect'
import { readAcpFixture } from '../../../../acp/acp-timeline-fixture.test-support'
import { structuredRewindCut } from '../../rewind/structured-rewind-cut'
import type { JournalReplacementItem } from '../../../agent-session-journal/context-epochs/journal-epoch-replacement'
import { prepareForkSnapshot } from '../structured-agent-session-fork-snapshot'
import type {
  AgentJournalSnapshot,
  AgentJournalItemBody
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { forkSession, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { prepareLegacyTranscriptImport } from '../../../agent-session-journal/history-import/journal-legacy-import'
import capture from '../../../../claude/__fixtures__/claude-plugin-recovery.json'
import { expect, it } from 'vitest'
import { claudeConversationForkBoundary } from '../../../../claude/claude-conversation-fork-boundary'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionRecordFixture } from '../../../agent-session-record-test-fixture'
import {
  fixture,
  appendItems,
  item
} from '../../publication/history/testing/agent-session-history-contract-test-fixture'
import { structuredAgentSessionForkBoundary } from '../structured-agent-session-fork-boundary'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId
} from '../structured-agent-session-history-catch-up'

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

it('freezes the selected mixed root, includes its late rows, and drops unfinished work with its dependents', () => {
  const k = (n: number) =>
    agentJournalItemKey({
      provider: 'codex',
      threadId: 'source',
      turnId: n < 4 ? 'T1' : 'T2',
      ordinal: n
    })
  const l = (id: string) =>
    agentJournalItemKey({ provider: 'legacy', agent: 'codex', sessionId: 'source', recordId: id })
  const row = (itemId: string, body: AgentJournalItemBody, turnItemId?: string) => ({
    itemId,
    body,
    sequence: 1,
    revision: 1,
    observedAt: 123,
    ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
  })
  const snapshot: AgentJournalSnapshot = {
    sessionId: 'source-chat',
    cursor: { epoch: 'epoch', sequence: 10 },
    submissions: [],
    items: [
      row(k(0), { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }),
      row(l('root1'), { kind: 'turn', turnId: 'T1', userItemId: k(0), state: 'completed' }),
      row(
        k(1),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'rich original' }] },
        l('root1')
      ),
      {
        ...row(l(continuedOutsideRecordId('T1')), continuedOutsideNotice(false)),
        turnScope: { kind: 'thread' }
      },
      row(
        l('running'),
        { kind: 'tool-call', name: 'command', callId: 'call-running', input: {}, state: 'running' },
        l('root1')
      ),
      row(l('dependent'), { kind: 'status', text: 'linked work' }, l('running')),
      row(l('transitive'), { kind: 'status', text: 'linked descendant' }, l('dependent')),
      row(
        l('helper'),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'Kicked off subagent Audit' },
            {
              type: 'subagent',
              id: 'child-1',
              label: 'Audit',
              groupId: 'T1',
              state: 'working',
              background: true
            }
          ]
        },
        l('root1')
      ),
      row(
        l('legacy-helpers'),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'T1',
              agents: [{ id: 'legacy-child', label: 'Legacy', state: 'working' }]
            }
          ]
        },
        l('root1')
      ),
      {
        ...row(l('helper-output'), { kind: 'status', text: 'completed child output' }),
        agentId: 'child-1',
        producerKind: 'agent'
      },
      {
        ...row(l('nested-output'), { kind: 'status', text: 'nested output' }),
        agentId: 'nested',
        parentAgentId: 'child-1',
        producerKind: 'agent'
      },
      {
        ...row(l('legacy-output'), { kind: 'status', text: 'legacy output' }),
        agentId: 'legacy-child',
        producerKind: 'agent'
      },
      {
        ...row(l('linked-tool-output'), { kind: 'status', text: 'tool output' }),
        agentId: 'tool-child',
        providerParentRef: 'call-running',
        producerKind: 'agent'
      },
      {
        ...row(l('tool-descendant'), { kind: 'status', text: 'tool descendant' }),
        agentId: 'tool-descendant',
        parentAgentId: 'tool-child',
        producerKind: 'agent'
      },
      {
        ...row(l(continuedOutsideRecordId('T2')), continuedOutsideNotice(false)),
        turnScope: { kind: 'thread' }
      },
      row(k(4), { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'second' }] }),
      row(
        l('late'),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'late retained detail' }]
        },
        l('root1')
      ),
      row(l('notice'), { kind: 'status', text: 'later unscoped notice' }),
      row(
        l('tool'),
        {
          kind: 'tool-call',
          name: 'command',
          input: { turnItemId: k(0), userItemId: l('running') },
          state: 'completed'
        },
        l('root1')
      ),
      row(
        l('settled-helper'),
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'subagent', id: 'C', label: 'Audit', groupId: 'T1', state: 'completed' }]
        },
        l('root1')
      ),
      {
        ...row(
          l('settled-goal'),
          { kind: 'status', text: 'Goal cleared', threadGoal: { state: 'cleared' } },
          l('root1')
        ),
        agentId: 'C',
        producerKind: 'agent'
      },
      {
        ...row(
          l('settled-answer'),
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Completed audit' }]
          },
          l('root1')
        ),
        agentId: 'C',
        producerKind: 'agent'
      }
    ]
  }
  const original = structuredClone(snapshot)
  const copied = prepareForkSnapshot({
    snapshot,
    nextItemId: k(4),
    sourceThreadId: 'source',
    childThreadId: 'child'
  })
  expect(snapshot).toEqual(original)
  expect(copied.map((item) => agentJournalItemKey(item.identity))).toEqual([
    'codex:child:T1:0',
    'legacy:codex:source:root1',
    'codex:child:T1:1',
    'legacy:codex:source:continued-outside%3AT1',
    'legacy:codex:source:late',
    'legacy:codex:source:tool',
    'legacy:codex:source:settled-helper',
    'legacy:codex:source:settled-answer'
  ])
  expect(copied[1]?.body).toEqual({
    kind: 'turn',
    turnId: 'T1',
    userItemId: 'codex:child:T1:0',
    state: 'completed'
  })
  expect(copied[5]?.body).toMatchObject({
    input: { turnItemId: 'codex:source:T1:0', userItemId: 'legacy:codex:source:running' }
  })
  snapshot.items[2]!.body = { kind: 'status', text: 'changed source' }
  expect(copied[2]).toMatchObject({
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'rich original' }] },
    observedAt: 123,
    ownerFence: 0,
    turnScope: { kind: 'turn', turnItemId: 'legacy:codex:source:root1' }
  })
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

it.each(['rewind', 'persisted', 'unrelated T3', 'saved fork'])(
  'forks FOXTROT without the orphan terminal notice: %s',
  async (route) => {
    const native = (turnId: string, ordinal: number) =>
      ({ provider: 'codex', threadId: 'thread-1', turnId, ordinal }) as const
    const legacy = (recordId: string) =>
      ({ provider: 'legacy', agent: 'codex', sessionId: 'session-1', recordId }) as const
    const root1 = agentJournalItemKey(legacy('root1'))
    const root2 = agentJournalItemKey(legacy('root2'))
    const source: JournalReplacementItem[] = (
      [
        {
          identity: native('T1', 0),
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
        },
        {
          identity: legacy('root1'),
          body: {
            kind: 'turn',
            turnId: 'T1',
            userItemId: 'codex:thread-1:T1:0',
            state: 'completed'
          }
        },
        {
          identity: native('T1', 1),
          turnScope: { kind: 'turn', turnItemId: root1 },
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'FOXTROT' }] }
        },
        {
          identity: legacy(continuedOutsideRecordId('T2')),
          body: continuedOutsideNotice(false),
          turnScope: { kind: 'thread' }
        },
        {
          identity: legacy('root2'),
          body: {
            kind: 'turn',
            turnId: 'T2',
            userItemId: 'codex:thread-1:T2:0',
            state: 'completed'
          }
        },
        {
          identity: native('T2', 0),
          turnScope: { kind: 'turn', turnItemId: root2 },
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'terminal prompt' }]
          }
        },
        {
          identity: native('T2', 1),
          turnScope: { kind: 'turn', turnItemId: root2 },
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'terminal answer' }]
          }
        }
      ] satisfies Omit<JournalReplacementItem, 'observedAt' | 'ownerFence'>[]
    ).map((row) => ({ ...row, observedAt: 123, ownerFence: 0 }))
    const journal = fixture.journal
    await journal.replaceEpochItems('session_created', 1, source)
    if (route === 'rewind') {
      const cut = structuredRewindCut(journal, {
        itemId: 'codex:thread-1:T2:0',
        provider: 'codex',
        nativeId: 'thread-1'
      })
      expect(cut).not.toBeNull()
      await journal.replaceEpochItems('handle_forked', 1, cut!.kept)
    } else {
      await journal.replaceEpochItems('session_created', 1, [
        ...source.slice(0, 4),
        // Earlier work alone cannot be introduced by a later notice.
        {
          identity: legacy(continuedOutsideRecordId('T1')),
          body: continuedOutsideNotice(false),
          observedAt: 123,
          ownerFence: 0
        },
        ...(route === 'unrelated T3'
          ? [
              {
                identity: legacy('root3'),
                body: { kind: 'turn' as const, turnId: 'T3', state: 'completed' as const },
                observedAt: 123,
                ownerFence: 0
              },
              {
                ...source[5]!,
                identity: native('T3', 0),
                turnScope: {
                  kind: 'turn' as const,
                  turnItemId: agentJournalItemKey(legacy('root3'))
                }
              }
            ]
          : [])
      ])
    }
    const record = agentSessionRecordFixture({ sessionId: 'session-1', provider: 'codex' })
    let snapshot = journal.snapshot()
    let selected = 'codex:thread-1:T1:1'
    let sourceThreadId = 'thread-1'
    if (route === 'saved fork') {
      const copied = prepareForkSnapshot({
        snapshot,
        nextItemId: null,
        sourceThreadId,
        childThreadId: 'child'
      })
      await journal.replaceEpochItems('session_created', 1, [
        ...copied,
        source[3]!,
        {
          identity: legacy('fork-marker'),
          body: {
            kind: 'status',
            text: 'Forked',
            forkedFrom: { sessionId: 'parent' }
          },
          observedAt: 123,
          ownerFence: 0
        }
      ])
      snapshot = journal.snapshot()
      selected = 'codex:child:T1:1'
      sourceThreadId = 'child'
    }
    const boundary = structuredAgentSessionForkBoundary(snapshot, record, selected)
    expect(boundary).not.toBeNull()
    expect(
      prepareForkSnapshot({
        snapshot,
        nextItemId: boundary!.nextItemId,
        sourceThreadId,
        childThreadId: 'result'
      }).map((row) => agentJournalItemKey(row.identity))
    ).toEqual(['codex:result:T1:0', 'legacy:codex:session-1:root1', 'codex:result:T1:1'])
  }
)

it('retains the notice for an encoded ACP replay turn only while its introduced work survives', async () => {
  const frames = (await readAcpFixture('opencode-v2-reopen-outside'))
    .filter((frame) => frame.process === 'C' && frame.message.method === 'session/update')
    .map((frame) => ({ method: 'session/update', params: frame.message.params }))
  const first = acpHistoryTurns(frames, 'user-message-id')[0]!
  if (first.turn === null) {
    throw new Error('recorded replay has no user id')
  }
  const rows = translateHistoryTurn(
    {
      agent: 'opencode',
      sessionId: 'chat',
      providerSessionId: 'session-1',
      dialect: OPENCODE_ACP_DIALECT,
      identity: 'user-message-id'
    },
    { ...first, turn: first.turn }
  )
  const notice = {
    itemId: 'legacy:opencode:chat:continued-outside%3Amsg_15fad6c9f001d4ix8WtRMUSWtI',
    body: continuedOutsideNotice(false),
    turnScope: { kind: 'thread' as const }
  }
  const snapshot: AgentJournalSnapshot = {
    sessionId: 'chat',
    cursor: { epoch: 'epoch', sequence: 3 },
    submissions: [],
    items: [
      notice,
      ...rows.map((row) => ({ ...row, itemId: agentJournalItemKey(row.identity) }))
    ].map((row, index) => ({ ...row, sequence: index + 1, revision: 1, observedAt: 123 }))
  }
  expect(
    prepareForkSnapshot({ snapshot, nextItemId: null }).map((row) =>
      agentJournalItemKey(row.identity)
    )
  ).toEqual([
    'legacy:opencode:chat:continued-outside%3Amsg_15fad6c9f001d4ix8WtRMUSWtI',
    'legacy:opencode:chat:turn-lifecycle%3Ap%3Asession-1%3Amsg_15fad6c9f001d4ix8WtRMUSWtI',
    'legacy:opencode:chat:item%3Ap%3Asession-1%3Asession-1%2Fuser%253Amsg_15fad6c9f001d4ix8WtRMUSWtI'
  ])
  snapshot.items[2]!.body = { kind: 'tool-call', name: 'command', state: 'running', input: {} }
  expect(
    prepareForkSnapshot({ snapshot, nextItemId: null }).map((row) =>
      agentJournalItemKey(row.identity)
    )
  ).toEqual([])
  snapshot.items.pop()
  expect(
    prepareForkSnapshot({ snapshot, nextItemId: null }).map((row) =>
      agentJournalItemKey(row.identity)
    )
  ).toEqual([
    'legacy:opencode:chat:turn-lifecycle%3Ap%3Asession-1%3Amsg_15fad6c9f001d4ix8WtRMUSWtI'
  ])
})
