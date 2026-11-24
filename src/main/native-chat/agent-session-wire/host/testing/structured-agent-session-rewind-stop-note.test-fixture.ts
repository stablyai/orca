import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { expect, vi, type Mock } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'

export async function expectRawStopNoteRewindRecovery({
  host,
  store,
  rewind
}: {
  host: StructuredAgentSessionHost
  store: AgentSessionRecordStore
  rewind: Mock<NonNullable<StructuredAgentSessionAdapter['rewind']>>
}): Promise<void> {
  const caller = { callerKey: 'desktop' }
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const journal = host['sessions'].get(HOST_TEST_SESSION)!.journal
  const turn = { provider: 'orca', clientMessageId: 'kept-turn' } as const
  const note = { provider: 'orca', clientMessageId: 'stop:kept-turn' } as const
  const noteId = agentJournalItemKey(note)
  const unconfirmed: AgentJournalItemBody = {
    kind: 'status',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
  }
  await journal.appendItem(
    turn,
    { kind: 'turn', turnId: 'kept-turn', state: 'interrupted' },
    {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  await journal.appendItem(note, unconfirmed, {
    fence: 1,
    turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) }
  })
  const targetIdentity = {
    provider: 'codex',
    threadId: HOST_TEST_THREAD,
    turnId: 'drop',
    ordinal: 0
  } as const
  await journal.appendItem(targetIdentity, hostTestMessage('drop'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  const target = agentJournalItemKey(targetIdentity)
  expect(
    (await readTestJournalItems(journal)).find((item) => item.itemId === noteId)?.body
  ).toEqual({
    kind: 'status',
    text: 'Cancellation requested.'
  })
  rewind.mockImplementation(async () => ({ ok: true }))
  const replace = journal.completeRewind.bind(journal)
  const crash = vi.spyOn(journal, 'completeRewind').mockImplementationOnce(async (...args) => {
    await replace(...args)
    throw new Error('crashed after commit')
  })
  await expect(
    host.rewind(caller, {
      itemId: target,
      expectedEpoch: journal.physicalCursor().epoch,
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.rewind',
          sessionId: HOST_TEST_SESSION,
          fields: { itemId: target, expectedEpoch: journal.physicalCursor().epoch }
        })
      }
    })
  ).rejects.toThrow('crashed after commit')
  crash.mockRestore()
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
  expect(
    await host.attach(
      caller,
      hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
    )
  ).toMatchObject({ ok: true })
  // Rewind settlement runs in startup after attach; drain serialization before asserting.
  await host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
  expect(await journal.reads.itemBody(noteId)).toEqual(unconfirmed)
  expect(
    (await readTestJournalItems(journal)).find((item) => item.itemId === noteId)?.body
  ).toEqual({
    kind: 'status',
    text: 'Cancellation requested.'
  })
  expect(rewind).toHaveBeenCalledTimes(1)
}
