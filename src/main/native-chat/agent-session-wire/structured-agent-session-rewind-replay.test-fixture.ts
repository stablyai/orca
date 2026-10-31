import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { expect, vi, type Mock } from 'vitest'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'

type RewindReplayFixture = {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  rewind: Mock<NonNullable<StructuredAgentSessionAdapter['rewind']>>
  recoverRewind: Mock<NonNullable<StructuredAgentSessionAdapter['recoverRewind']>>
  seed: () => Promise<string>
  params: (itemId: string) => Promise<Parameters<StructuredAgentSessionHost['rewind']>[1]>
}
const caller = { callerKey: 'desktop' }

export async function expectSupersededRewindReplay({
  host,
  store,
  rewind,
  recoverRewind,
  seed,
  params
}: RewindReplayFixture) {
  const target = await seed()
  const firstRequest = await params(target)
  const first = await host.rewind(caller, firstRequest)
  expect(first).toMatchObject({ ok: true })
  const secondRequest = await params(
    agentJournalItemKey({
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'kept',
      ordinal: 0
    })
  )
  recoverRewind.mockResolvedValueOnce({ ok: true })
  expect(await host.rewind(caller, secondRequest)).toMatchObject({ ok: true })
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.operationId).toBe(
    secondRequest.envelope.clientOperationId
  )
  const effects = rewind.mock.calls.length
  const replay = await host.rewind(caller, firstRequest)
  expect(replay).toMatchObject({ ok: true, replayed: true })
  if (first.ok && replay.ok) {
    expect(replay.value).toEqual(first.value)
  }
  expect(rewind).toHaveBeenCalledTimes(effects)
}

export async function expectRetainedPrefixRewindReplay({
  host,
  rewind,
  seed,
  params
}: Pick<RewindReplayFixture, 'host' | 'rewind' | 'seed' | 'params'>) {
  const target = await seed()
  const request = await params(target)
  const result = await host.rewind(caller, request)
  expect(result).toMatchObject({ ok: true })
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).items).toHaveLength(1)
  expect((await host.journalSnapshot(HOST_TEST_SESSION)).cursor.epoch).not.toBe(
    request.expectedEpoch
  )
  expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
  expect(rewind).toHaveBeenCalledTimes(1)
}

export async function expectAtomicRewindCompletion({
  host,
  store,
  seed,
  params,
  attachAndStart
}: Pick<RewindReplayFixture, 'host' | 'store' | 'seed' | 'params'> & {
  attachAndStart: (fence: number | null) => Promise<unknown>
}) {
  const target = await seed()
  const request = await params(target)
  const replaceBeforeCrash = AgentSessionJournal.prototype.replaceEpochItems
  const checkpoint = vi
    .spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
    .mockImplementationOnce(async function (this: AgentSessionJournal, ...args) {
      await replaceBeforeCrash.apply(this, args)
      throw new Error('completion write failed')
    })
  await expect(host.rewind(caller, request)).rejects.toThrow('completion write failed')
  const committed = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(committed.cursor.epoch).not.toBe(request.expectedEpoch)
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
  checkpoint.mockRestore()
  const replace = vi.spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
  expect(
    await attachAndStart(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
  ).toMatchObject({ ok: true })
  expect(await host.journalSnapshot(HOST_TEST_SESSION)).toEqual(committed)
  expect(replace).not.toHaveBeenCalled()
  replace.mockRestore()
  expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
}

export async function expectLargeRetainedPrefixRewind({
  host,
  store,
  rewind,
  sink,
  params
}: Pick<RewindReplayFixture, 'host' | 'store' | 'rewind' | 'params'> & {
  sink: () => StructuredAgentSessionEventSink
}) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const events = sink()
  const message = (turnId: string) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal: 0
  })
  for (let turn = 0; turn < 300; turn++) {
    events.appendItem(message(`kept-${turn}`), hostTestMessage('x'.repeat(12_000)), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  for (const turnId of ['drop', 'tip']) {
    events.appendItem(message(turnId), hostTestMessage(turnId), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)

  expect(
    await host.rewind(caller, await params(agentJournalItemKey(message('drop'))))
  ).toMatchObject({ ok: true })
  expect(rewind).toHaveBeenCalledWith(expect.objectContaining({ beforeTurnId: 'drop' }))
  const { items } = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(items.map(({ itemId }) => itemId)).toEqual(
    Array.from({ length: 300 }, (_, turn) => agentJournalItemKey(message(`kept-${turn}`)))
  )
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind).toMatchObject({ phase: 'completed' })
}

export async function expectGoalRowRewindRecovery({
  host,
  store,
  rewind,
  sink,
  params,
  attachAndStart
}: Pick<RewindReplayFixture, 'host' | 'store' | 'rewind' | 'params'> & {
  sink: () => StructuredAgentSessionEventSink
  attachAndStart: (fence: number) => Promise<unknown>
}) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const message = (turnId: string) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal: 0
  })
  const goalRow = {
    provider: 'orca' as const,
    clientMessageId: `codex-goal:${'1'.repeat(64)}:${'2'.repeat(64)}:${'3'.repeat(64)}`
  }
  const goalBody = {
    kind: 'status' as const,
    text: 'Goal set: Survive recovery.',
    providerFrame: {
      provider: 'codex',
      kind: 'notification:thread/goal/updated',
      payload: { head: '{}', byteLength: 2, digest: '4'.repeat(64), truncated: false }
    }
  }
  sink().appendItem(message('kept'), hostTestMessage('kept'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  sink().appendItem(goalRow, goalBody, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  sink().appendItem(message('drop'), hostTestMessage('drop'), {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  sink().appendItem(
    message('tip'),
    { ...hostTestMessage('tip'), role: 'assistant' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  rewind.mockImplementationOnce(async () => {
    throw new Error('lost after provider revert')
  })

  await expect(
    host.rewind(caller, await params(agentJournalItemKey(message('drop'))))
  ).rejects.toThrow('lost after provider revert')
  expect(
    await attachAndStart(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
  ).toMatchObject({ ok: true })

  expect(
    (await host.journalSnapshot(HOST_TEST_SESSION)).items.map(({ itemId, body }) => ({
      itemId,
      body
    }))
  ).toEqual([
    { itemId: agentJournalItemKey(message('kept')), body: hostTestMessage('kept') },
    { itemId: agentJournalItemKey(goalRow), body: goalBody }
  ])
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
}
