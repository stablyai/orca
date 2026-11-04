import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'

export async function rewindTestParams(
  getHost: () => StructuredAgentSessionHost,
  getStore: () => AgentSessionRecordStore,
  itemId: string,
  epoch?: string
) {
  const expectedEpoch = epoch ?? (await getHost().journalSnapshot(HOST_TEST_SESSION)).cursor.epoch
  return {
    itemId,
    expectedEpoch,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: getStore().getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields: { itemId, expectedEpoch }
      })
    }
  }
}
