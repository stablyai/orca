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
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

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
