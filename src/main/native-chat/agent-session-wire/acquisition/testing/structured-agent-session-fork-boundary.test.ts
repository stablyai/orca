import { fixture } from '../../publication/history/testing/agent-session-history-contract-test-fixture'
import { PI_CWD_BUCKET_LAYOUT } from '../../../../ai-vault/session-cwd-bucket-layouts'
import { prepareStructuredAgentSessionFork } from '../structured-agent-session-fork'
import type { StructuredAgentSessionHost } from '../../host/structured-agent-session-host'
import { acpHistoryTurns } from '../../../../acp/history/acp-history-replay'
import { translateHistoryTurn } from '../../../../acp/history/acp-history-translation'
import { OPENCODE_ACP_DIALECT } from '../../../../acp/acp-dialects/opencode-dialect'
import { readAcpFixture } from '../../../../acp/timeline/testing/acp-timeline-fixture.test-support'
import { structuredRewindCut } from '../../rewind/structured-rewind-cut'
import type { JournalReplacementItem } from '../../../agent-session-journal/context-epochs/journal-epoch-replacement'
import { prepareForkSnapshot } from '../structured-agent-session-fork-snapshot'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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

it('refuses an imported ACP tip with assistant prose but no native terminal evidence', async () => {
  const nativeId = '019e6b26-18e2-7103-b7a0-7ba6bb071123'
  const home = join(fixture.root, 'omp-account')
  const sessions = join(home, 'sessions')
  const directory = join(sessions, `${PI_CWD_BUCKET_LAYOUT.encodeScopePrefixes(fixture.root)[0]}--`)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${nativeId}.jsonl`),
    `${[
      { type: 'session', version: 3, id: nativeId, cwd: fixture.root },
      {
        type: 'message',
        id: 'prompt',
        parentId: null,
        message: { role: 'user', content: 'Remember 57319' }
      },
      {
        type: 'message',
        id: 'response',
        parentId: 'prompt',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Remembered' }] }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  for (const [recordId, role] of [
    ['prompt', 'user'],
    ['response', 'assistant']
  ] as const) {
    await fixture.journal.appendItem(
      { provider: 'legacy', agent: 'omp', sessionId: nativeId, recordId },
      {
        kind: 'message',
        role,
        blocks: [{ type: 'text', text: role === 'user' ? 'Remember 57319' : 'Remembered' }]
      },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  }
  const record = agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'omp',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: home },
    launchDirectory: fixture.root,
    providerHandleChain: [
      {
        linkId: 'omp-head',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1,
        handle: { transport: 'acp', agent: 'omp', nativeId }
      }
    ]
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: boundary preparation reads only these saved source and adapter facets.
  const host = {
    deps: {
      store: {
        selectWritableRecord: () => ({ kind: 'writable' }),
        requireWritableRecord: () => record,
        admittedSendCount: () => 0
      },
      agents: { capabilities: () => ({ fork: 'tip' }) },
      adapter: {
        copyConversation: async () => {
          throw new Error('unexpected copy')
        }
      },
      resolveLaunchEnv: async () => ({ PI_CODING_AGENT_DIR: home, OMP_CODING_AGENT_DIR: sessions })
    },
    journalSnapshot: async () => fixture.journal.snapshot()
  } as unknown as StructuredAgentSessionHost
  await expect(
    prepareStructuredAgentSessionFork({
      host,
      agent: 'omp',
      sessionId: 'session-1',
      throughItemId: 'legacy:omp:019e6b26-18e2-7103-b7a0-7ba6bb071123:response',
      location: record.location,
      envelope: {
        sessionId: 'omp-child',
        clientOperationId: 'copy',
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
  ).rejects.toMatchObject({ refusal: { details: { reason: 'turnActive' } } })
})
