import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { writeFile } from 'node:fs/promises'
import { importLegacyTranscriptIntoJournal } from '../../../native-chat/agent-session-journal/journal-legacy-import'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { join } from 'node:path'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { recoverStructuredRewind } from '../../../native-chat/agent-session-wire/rewind/structured-rewind-recovery'
import { usableJournalHistoryOrigin } from '../../../native-chat/agent-session-journal/journal-history-origin'
import { describe, expect, it } from 'vitest'
import { registerCodexCatchUpEchoTests } from './codex-structured-thread-catch-up-echo.spec'
import { projectStructuredItemsToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { createCodexJournalTranslator } from '../journal/codex-structured-journal-translation'
import {
  SESSION,
  THREAD,
  chat,
  turn,
  codexWith
} from './codex-thread-catch-up-contract-test-fixture'
describe('Codex chat catch-up', () => {
  registerCodexCatchUpEchoTests({ chat, turn, codexWith, sessionId: SESSION, threadId: THREAD })

  it('retains the complete outside answer tail through catch-up, disk reopen and display', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([turn(1)])
    const answer = `${'outside answer paragraph\n'.repeat(1_024)}END-OF-OUTSIDE-ANSWER-30883`
    const outside = { ...turn(2), items: [{ type: 'agentMessage', id: 'a-2', text: answer }] }
    await c.open([turn(1), outside])
    await c.reopen()
    const items = c.journal.snapshot().items
    const stored = items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.role === 'assistant' &&
        item.body.blocks.some((block) => block.type === 'text' && block.text === answer)
    )
    expect(stored?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: answer }]
    })
    const displayed = projectStructuredItemsToNativeChat(items).flatMap((message) => message.blocks)
    expect(displayed).toContainEqual({ type: 'text', text: answer })
  })

  it('adds the turns made outside the chat once, in order, after the chat rows', async () => {
    const c = await chat({ now: 1_000 })

    await c.open([turn(1)])
    expect(c.texts()).toEqual(['user:ask 1', 'assistant:answer 1'])

    await c.open([turn(1), turn(2), turn(3)])
    const caughtUp = [
      'user:ask 1',
      'assistant:answer 1',
      '(continued-outside)',
      'user:ask 2',
      'assistant:answer 2',
      'user:ask 3',
      'assistant:answer 3'
    ]
    expect(c.texts()).toEqual(caughtUp)

    await c.open([turn(1), turn(2), turn(3)])
    expect(c.texts()).toEqual(caughtUp)

    // An external rewind preserves displayed rows and adds a notice.
    await c.open([turn(1), turn(2), turn(4)])
    expect(c.texts().slice(caughtUp.length)).toEqual([
      '(continued-outside-rewound)',
      'user:ask 4',
      'assistant:answer 4'
    ])

    // Summary-only history cannot be imported.
    await c.open([turn(1), turn(2), turn(4), turn(6, 'summary')])
    expect(c.texts().slice(caughtUp.length + 3)).toEqual([])
  })

  it('recovers an older gap behind newer native work after a failed read and restart', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([turn(1)])
    const failed = {
      request: async () => {
        throw new Error('read failed')
      }
    }
    await c.open([turn(1), turn(2)], { connection: failed })
    const native = createCodexJournalTranslator({
      sink: c.deferred.sink,
      sessionId: SESSION,
      primaryThreadId: () => THREAD
    })
    for (const [method, params] of [
      ['turn/started', { turn: { id: 'turn-3' } }],
      [
        'item/completed',
        { turnId: 'turn-3', item: { type: 'agentMessage', id: 'native', text: 'native C' } }
      ],
      ['turn/completed', { turn: { id: 'turn-3', status: 'completed' } }]
    ] as const) {
      native.handle({ type: 'notification', sessionId: SESSION, threadId: THREAD, method, params })
    }
    await c.deferred.drained()
    native.dispose()
    const before = c.journal.snapshot().items
    await c.reopen()
    await c.open([turn(1), turn(2), turn(3)])
    expect(c.journal.snapshot().items.slice(0, before.length)).toEqual(before)
    expect(c.texts().slice(-4)).toEqual([
      '(continued-outside)',
      'user:ask 2',
      'assistant:answer 2',
      'assistant:answer 3'
    ])
    await c.open([turn(1), turn(2), turn(3), turn(4)])
    expect(c.texts().slice(-3)).toEqual(['(continued-outside)', 'user:ask 4', 'assistant:answer 4'])
  })

  it('uses the continued-outside notice after a receipt-only known turn', async () => {
    const c = await chat({ now: 1_000 })
    const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
    await c.journal.appendSubmission({
      clientMessageId: 'receipt',
      body,
      payloadFingerprint: 'receipt',
      fence: 1
    })
    await c.journal.resolveDispatch({
      clientMessageId: 'receipt',
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
      fence: 1
    })
    await c.open([turn(1), turn(2)])
    expect(c.texts().slice(-3)).toEqual(['(continued-outside)', 'user:ask 2', 'assistant:answer 2'])
  })

  it('commits a 600-message import once, rolls back a later partition failure, and recovers', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([turn(1)])
    const before = c.journal.snapshot()
    const large = {
      ...turn(2),
      items: Array.from({ length: 600 }, (_, n) => ({
        type: 'agentMessage',
        id: `item-${n}`,
        text: `answer ${n}`
      }))
    }
    const seq = c.journal.cursor().sequence
    c.db.exec(
      `CREATE TRIGGER fail_later_partition BEFORE INSERT ON journal_rows WHEN NEW.seq > ${seq + 1} BEGIN SELECT RAISE(ABORT, 'injected later partition failure'); END`
    )
    expect((await c.open([turn(1), large])).ok).toBe(false)
    expect(c.deferred.state().failed).toBe(true)
    expect(c.journal.snapshot()).toEqual(before)
    c.db.exec('DROP TRIGGER fail_later_partition')
    await c.reopen()
    expect(c.journal.snapshot()).toEqual(before)
    c.publications.length = 0
    await c.open([turn(1), large])
    expect(c.texts()).toHaveLength(603)
    expect(c.publications).toEqual([before.items.length + 602])
    await c.reopen()
    await c.open([turn(1), large])
    expect(c.texts()).toHaveLength(603)
  })

  it('keeps rollback reasoning and message identities immutable across turns', async () => {
    const c = await chat({ now: 1_000 })
    const withReasoning = (n: number) => ({
      ...turn(n),
      items: [
        { type: 'reasoning', id: 'item-2', summary: [{ text: `reason ${n}` }] },
        { type: 'agentMessage', id: 'same-message-id', text: `answer ${n}` }
      ]
    })
    await c.open([withReasoning(1)])
    const before = c.journal.snapshot().items
    await c.open([withReasoning(2)])
    expect(c.journal.snapshot().items.slice(0, before.length)).toEqual(before)
    expect(c.texts().filter((text) => text.startsWith('assistant:'))).toEqual([
      'assistant:answer 1',
      'assistant:answer 2'
    ])
    const reasoning = c.journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'reasoning')
    expect(new Set(reasoning.map((item) => item.itemId)).size).toBe(2)
    expect(new Set(reasoning.map((item) => JSON.stringify(item.turnScope))).size).toBe(2)
  })

  it('retains the original adoption cutoff through native rewind and disk recovery', async () => {
    const clock = { now: 50_000 }
    const c = await chat(clock)
    let store = await openTestAgentSessionRecordStore(c.root)
    const callerKey = 'catch-up-test'
    await store.reserveOwner({
      sessionId: SESSION,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(c.root, 'qa-codex') },
      expectedFence: null,
      spawnToken: 'fixture-only',
      claimKeyId: 'fixture',
      handoffOperationId: null,
      probe: { outcome: 'indeterminate', reason: 'fixture' },
      operation: {
        callerKey,
        operationId: '0000000050000-00000000000000000000000000000001',
        fingerprint: 'create'
      },
      now: clock.now
    })
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence: 1,
      process: {
        hostId: 'local',
        pid: 424242,
        processStartTimeMs: clock.now,
        spawnToken: 'fixture-only'
      },
      now: clock.now
    })
    await store.proveOwner({
      sessionId: SESSION,
      fence: 1,
      link: {
        linkId: 'adopted',
        handle: codexProviderHandle(THREAD),
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: clock.now
      },
      now: clock.now
    })
    const filePath = join(c.root, 'rollout.jsonl')
    await writeFile(
      filePath,
      [
        {
          timestamp: '1970-01-01T00:01:40.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'old A ask' }
        },
        {
          timestamp: '1970-01-01T00:01:50.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'old A answer' }
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    )
    clock.now = 200_000
    expect(
      await importLegacyTranscriptIntoJournal({
        journal: c.journal,
        agent: 'codex',
        sessionId: THREAD,
        fence: 1,
        options: { filePath }
      })
    ).toMatchObject({ ok: true, imported: 2 })
    const original = c.journal.snapshot().items
    const dated = (n: number) => ({ ...turn(n), startedAt: n, completedAt: n + 10 })
    await c.open([dated(100), dated(300)])
    const target = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: 'turn-300',
      ordinal: 0
    })
    const operationId = '0000000500000-00000000000000000000000000000002'
    await store.admitOperation({
      callerKey,
      operationId,
      fingerprint: 'rewind',
      now: 500_000
    })
    await store.transitionHandoff(SESSION, (record) => ({
      ...record,
      rewind: {
        operationId,
        callerKey,
        itemId: target,
        expectedEpoch: c.journal.epoch,
        phase: 'provider-succeeded'
      }
    }))
    clock.now = 500_000
    const deps = () => ({ store, logger: testEventSinkLogging().logger })
    await recoverStructuredRewind(deps(), SESSION, c.journal, 1)
    expect(
      c.journal
        .snapshot()
        .items.slice(0, original.length)
        .map(({ itemId, body, observedAt, turnScope }) => ({ itemId, body, observedAt, turnScope }))
    ).toEqual(
      original.map(({ itemId, body, observedAt, turnScope }) => ({
        itemId,
        body,
        observedAt,
        turnScope
      }))
    )
    await c.reopen()
    store = await openTestAgentSessionRecordStore(c.root)
    await recoverStructuredRewind(deps(), SESSION, c.journal, 1)
    expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
    expect(usableJournalHistoryOrigin(c.journal.historyOrigin())?.importedAt).toBe(200_000)
    await c.open([dated(100), dated(150), dated(200), dated(250), dated(600)])
    expect(c.texts().filter((text) => text.startsWith('assistant:'))).toEqual([
      'assistant:old A answer',
      'assistant:answer 250',
      'assistant:answer 600'
    ])
    expect(
      c.journal
        .snapshot()
        .items.slice(0, original.length)
        .map(({ itemId, body, observedAt, turnScope }) => ({ itemId, body, observedAt, turnScope }))
    ).toEqual(
      original.map(({ itemId, body, observedAt, turnScope }) => ({
        itemId,
        body,
        observedAt,
        turnScope
      }))
    )
    const complete = c.journal.snapshot()
    await c.reopen()
    await c.open([dated(100), dated(150), dated(200), dated(250), dated(600)])
    expect(c.journal.snapshot()).toEqual(complete)
  })

  it('keeps erased-origin legacy chats readable without guessing from native IDs', async () => {
    const c = await chat({ now: 200_000 })
    const kept = {
      identity: { provider: 'legacy', agent: 'codex', sessionId: THREAD, recordId: '#0' } as const,
      ownerFence: 1,
      body: {
        kind: 'message' as const,
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'legacy' }]
      }
    }
    await c.journal.replaceEpochItems('session_created', 1, [kept])
    await c.reopen()
    await c.journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'native', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ordinary reply' }] },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    await c.open([turn(3)])
    expect(c.texts()).toEqual(['user:legacy', 'assistant:ordinary reply'])
  })
})
