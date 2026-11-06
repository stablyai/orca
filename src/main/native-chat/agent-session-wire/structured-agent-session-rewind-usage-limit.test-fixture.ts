import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { expect, vi } from 'vitest'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  HOST_TEST_SESSION,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** A usage-limited turn whose reset is a minute after `clock`; tie it to a turn the rewind keeps. */
export async function appendRewindUsageLimitedTurn(journal: AgentSessionJournal, clock: number) {
  const key = { provider: 'orca' as const, clientMessageId: 'limited-before-rewind' }
  const turnItemId = agentJournalItemKey(key)
  await journal.appendItem(
    key,
    {
      kind: 'turn',
      turnId: 'kept',
      providerTurnId: 'kept',
      state: 'completed',
      outcome: 'failure',
      startedAt: clock,
      completedAt: clock
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const resetsAt = clock + 60_000
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'kept-limit' },
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt } }),
        { surface: 'row' }
      )
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
  return { turnItemId, resetsAt }
}

export async function expectRestoredUsageLimitCancelled(
  host: StructuredAgentSessionHost,
  store: AgentSessionRecordStore,
  cut: { turnItemId: string; resetsAt: number }
) {
  const restored = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(latestNativeChatUsageLimitCut(restored.items, restored.submissions)).toMatchObject(cut)
  expect(store.getRecord(HOST_TEST_SESSION)?.usageLimitContinueCancel).toEqual(cut)
  expect(host.usageLimitContinue.readState(HOST_TEST_SESSION)?.state).toBe('cancelled')
}

export async function expectUsageLimitRewindCancellation({
  host,
  store,
  target,
  params,
  clock
}: {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  target: string
  params: (itemId: string) => Promise<Parameters<StructuredAgentSessionHost['rewind']>[1]>
  clock: number
}) {
  const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const cut = await appendRewindUsageLimitedTurn(journal, clock)
  expect(await host.rewind({ callerKey: 'desktop' }, await params(target))).toMatchObject({
    ok: true
  })
  await expectRestoredUsageLimitCancelled(host, store, cut)
}

/** Past the reset, a visible chat with the setting on still sends nothing automatically. */
export async function expectNoUsageLimitAutoContinue(host: StructuredAgentSessionHost) {
  const sent = vi.spyOn(host, 'send')
  await host.usageLimitContinue.tick()
  expect(sent).not.toHaveBeenCalled()
  expect(host.usageLimitContinue.readState(HOST_TEST_SESSION)?.state).toBe('cancelled')
}

export async function expectReopenedUsageLimitCancellation(
  host: StructuredAgentSessionHost,
  store: AgentSessionRecordStore
) {
  await expectNoUsageLimitAutoContinue(host)
  const turnItemId = store.getRecord(HOST_TEST_SESSION)!.usageLimitContinueCancel!.turnItemId
  expect(
    await host.send(
      { callerKey: 'desktop' },
      structuredAgentSessionMessageSendMutation({
        sessionId: HOST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
        body: hostTestMessage('Continue where you left off.'),
        usageLimitContinuationOfTurnItemId: turnItemId
      })
    )
  ).toMatchObject({ ok: true })
}

export async function expectUsageLimitCompletionRollback({
  host,
  store,
  seed,
  params,
  attachAndStart,
  directory,
  now,
  advanceClock,
  rewind
}: {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  seed: () => Promise<string>
  params: (id: string) => Promise<Parameters<StructuredAgentSessionHost['rewind']>[1]>
  attachAndStart: (fence: number) => ReturnType<StructuredAgentSessionHost['attach']>
  directory: string
  now: () => number
  advanceClock: () => void
  rewind: NonNullable<StructuredAgentSessionAdapter['rewind']>
}) {
  host.deps.usageLimitAutoContinue = {
    isEnabled: () => true,
    isWorkspaceAsleep: () => false,
    subscribe: () => () => {}
  }
  const target = await seed()
  await store.setSessionTabVisibility(HOST_TEST_SESSION, true)
  const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const cut = await appendRewindUsageLimitedTurn(journal, now())
  const request = await params(target)
  const before = await host.journalSnapshot(HOST_TEST_SESSION)
  const physical = journal.physicalCursor().epoch
  const db = openTestJournalHostDatabase(directory).db
  db.exec(`CREATE TEMP TRIGGER fail_rewind_completion BEFORE UPDATE ON agent_session_records
      WHEN instr(NEW.record_json, '"phase":"completed"') > 0
      BEGIN SELECT RAISE(ABORT, 'completion write failed'); END`)
  await expect(host.rewind({ callerKey: 'desktop' }, request)).rejects.toThrow(
    'completion write failed'
  )
  const committed = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(committed).toEqual(before)
  expect(committed.cursor.epoch).toBe(request.expectedEpoch)
  expect(journal.physicalCursor().epoch).toBe(physical)
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('provider-succeeded')
  expect(store.getRecord(HOST_TEST_SESSION)?.usageLimitContinueCancel).toBeUndefined()
  db.exec('DROP TRIGGER fail_rewind_completion')
  const replace = vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
  expect(
    await attachAndStart(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
  ).toMatchObject({ ok: true })
  const restored = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(restored.cursor.epoch).not.toBe(request.expectedEpoch)
  expect(journal.physicalCursor().epoch).toBe(physical)
  expect(restored.items.map(({ itemId }) => itemId)).toEqual([
    before.items[0]!.itemId,
    cut.turnItemId,
    agentJournalItemKey({ provider: 'orca', clientMessageId: 'kept-limit' })
  ])
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
  expect(replace).toHaveBeenCalledTimes(1)
  expect(rewind).toHaveBeenCalledTimes(1)
  replace.mockRestore()
  await expectRestoredUsageLimitCancelled(host, store, cut)
  expect(await host.rewind({ callerKey: 'desktop' }, request)).toMatchObject({
    ok: true,
    replayed: true
  })
  await host.flushAllStreamedEvents()
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({ ...host.deps, store })
  advanceClock()
  await expectReopenedUsageLimitCancellation(host, store)
  return { host, store }
}
