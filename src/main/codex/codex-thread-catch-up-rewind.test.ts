import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { importLegacyTranscriptIntoJournal } from '../native-chat/agent-session-journal/journal-legacy-import'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { recoverStructuredRewind } from '../native-chat/agent-session-wire/structured-rewind-recovery'
import { usableJournalHistoryOrigin } from '../native-chat/agent-session-journal/journal-history-origin'

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
  expect(c.journal.snapshot().items.slice(0, original.length)).toEqual(original)
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
  expect(c.journal.snapshot().items.slice(0, original.length)).toEqual(original)
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
