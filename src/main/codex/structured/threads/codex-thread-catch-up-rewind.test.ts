import {
  readTestJournalItems,
  readTestJournalSnapshot
} from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { importLegacyTranscriptIntoJournal } from '../../../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { recoverStructuredRewind } from '../../../native-chat/agent-session-wire/rewind/structured-rewind-recovery'
import { usableJournalHistoryOrigin } from '../../../native-chat/agent-session-journal/context-epochs/journal-history-origin'

import { SESSION, THREAD, chat, turn } from './codex-thread-catch-up-contract-test-fixture'

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
  const original = await readTestJournalItems(c.journal)
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
  await store.updateRecord(SESSION, {
    kind: 'rewind',
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    rewind: {
      operationId,
      callerKey,
      itemId: target,
      expectedEpoch: c.journal.cursor().epoch,
      phase: 'provider-succeeded'
    }
  })
  clock.now = 500_000
  const deps = () => ({ store, logger: testEventSinkLogging().logger })
  await recoverStructuredRewind(deps(), SESSION, c.journal, 1)
  const restated = (await readTestJournalItems(c.journal)).slice(0, original.length)
  expect(restated).toHaveLength(original.length)
  // The cut keeps the imported rows exactly as saved.
  expect(restated).toEqual(original)
  await c.reopen()
  store = await openTestAgentSessionRecordStore(c.root)
  await recoverStructuredRewind(deps(), SESSION, c.journal, 1)
  expect(store.getRecord(SESSION)?.rewind?.phase).toBe('completed')
  expect(usableJournalHistoryOrigin(await c.journal.reads.historyOrigin())).toMatchObject({
    importedAt: 200_000
  })
  await c.open([dated(100), dated(150), dated(200), dated(250), dated(600)])
  expect((await c.texts()).filter((text) => text.startsWith('assistant:'))).toEqual([
    'assistant:old A answer',
    'assistant:answer 250',
    'assistant:answer 600'
  ])
  expect((await readTestJournalItems(c.journal)).slice(0, original.length)).toEqual(restated)
  const complete = await readTestJournalSnapshot(c.journal)
  await c.reopen()
  await c.open([dated(100), dated(150), dated(200), dated(250), dated(600)])
  expect(await readTestJournalSnapshot(c.journal)).toEqual(complete)
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
  await c.journal.write({
    kind: 'epoch-replace',
    reason: 'session_created',
    fence: 1,
    items: [kept]
  })
  await c.reopen()
  await c.journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'native', ordinal: 0 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ordinary reply' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await c.open([turn(3)])
  expect(await c.texts()).toEqual(['user:legacy', 'assistant:ordinary reply'])
})

it('keeps copied bodies while catching an uncovered same-second turn once across two opens and restart', async () => {
  const c = await chat({ now: 200_000 })
  await c.journal.write({
    kind: 'epoch-replace',
    reason: 'session_created',
    fence: 1,
    items: [
      {
        identity: { provider: 'legacy', agent: 'codex', sessionId: 'source', recordId: '#0' },
        ownerFence: 0,
        observedAt: 7,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'rich copied answer' }]
        }
      }
    ],
    historyOrigin: {
      version: 1,
      kind: 'native_copy',
      agent: 'codex',
      unit: 'codex-turn',
      providerHandle: { kind: 'codex', threadId: THREAD },
      ids: ['turn-1', 'turn-2']
    }
  })
  const input = [turn(1), turn(3)].map((value) => ({ ...value, startedAt: 200 }))
  await c.open(input, { returnedTurns: input })
  await c.open(input)
  await c.reopen()
  await c.open(input)
  expect((await c.texts()).filter((text) => text.startsWith('assistant:'))).toEqual([
    'assistant:rich copied answer',
    'assistant:answer 3'
  ])
  await c.journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 1, items: [] })
  await c.open([turn(1), turn(2), turn(4)])
  expect((await c.texts()).filter((text) => text.startsWith('assistant:'))).toEqual([
    'assistant:answer 4'
  ])
})
