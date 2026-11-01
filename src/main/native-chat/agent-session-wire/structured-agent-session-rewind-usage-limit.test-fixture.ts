import { expect, vi } from 'vitest'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'
import {
  HOST_TEST_SESSION,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

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
      text: 'Usage limit reached',
      failure: agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt } })
    },
    { fence: 1, turnScope: { kind: 'turn', turnItemId } }
  )
  expect(await host.rewind({ callerKey: 'desktop' }, await params(target))).toMatchObject({
    ok: true
  })
  const restored = await host.journalSnapshot(HOST_TEST_SESSION)
  expect(latestNativeChatUsageLimitCut(restored.items, restored.submissions)).toMatchObject({
    turnItemId,
    resetsAt
  })
  expect(store.getRecord(HOST_TEST_SESSION)?.usageLimitContinueCancel).toEqual({
    turnItemId,
    resetsAt
  })
  expect(host.usageLimitContinue.readState(HOST_TEST_SESSION)?.state).toBe('cancelled')
}

export async function expectReopenedUsageLimitCancellation(
  host: StructuredAgentSessionHost,
  store: AgentSessionRecordStore
) {
  const sent = vi.spyOn(host, 'send')
  await host.usageLimitContinue.tick()
  expect(sent).not.toHaveBeenCalled()
  expect(host.usageLimitContinue.readState(HOST_TEST_SESSION)?.state).toBe('cancelled')
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
