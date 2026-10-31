import { expect, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

export async function seedRewindItems(
  host: StructuredAgentSessionHost,
  store: AgentSessionRecordStore,
  adapter: StructuredAgentSessionAdapter,
  caller: Parameters<StructuredAgentSessionHost['attach']>[0],
  sink: () => StructuredAgentSessionEventSink,
  acceptedSubmissions = false
) {
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const keys = ['kept', 'drop', 'tip'].map((turnId) => ({
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId,
    ordinal: 0
  }))
  let selectedItemId = agentJournalItemKey(keys[1]!)
  for (const [i, identity] of keys.entries()) {
    const body = {
      ...hostTestMessage(String(i)),
      role: i === 2 ? ('assistant' as const) : ('user' as const)
    }
    if (acceptedSubmissions && i !== 2) {
      const clientOperationId = hostTestOperationId()
      vi.mocked(adapter.dispatch).mockResolvedValueOnce({
        state: 'accepted',
        providerIdentity: identity
      })
      expect(
        await host.send(caller, {
          body,
          envelope: {
            sessionId: HOST_TEST_SESSION,
            clientOperationId,
            expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId: HOST_TEST_SESSION,
              fields: { body }
            })
          }
        })
      ).toMatchObject({ ok: true })
      await vi.waitFor(async () =>
        expect(
          (await host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
            (entry) => entry.clientMessageId === clientOperationId
          )?.dispatchState
        ).toBe('accepted')
      )
      if (i === 1) {
        selectedItemId = agentJournalSubmissionKey(clientOperationId)
      }
    } else {
      sink().appendItem(identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
  }
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  return selectedItemId
}
