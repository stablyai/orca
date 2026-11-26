import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { AgentSessionProviderHandleChain } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { testEventSinkLogging } from '../host/testing/structured-agent-session-logger.test-fixture'
import { recoverStructuredRewind } from './structured-rewind-recovery'

/** Complete the saved provider mutation through the real atomic journal/record receipt. */
export async function completeTestJournalRewind(
  root: string,
  journal: AgentSessionJournal,
  itemId: string,
  fence = 1,
  providerHandleChain?: AgentSessionProviderHandleChain
) {
  const { sessionId, agent: provider, providerHandle } = journal.identity
  if (!providerHandle || (provider !== 'claude' && provider !== 'codex')) {
    throw new Error('rewind fixture requires a native provider handle')
  }
  const record = agentSessionRecordFixture({
    sessionId,
    provider,
    providerHandleChain: providerHandleChain ?? [
      {
        linkId: 'head',
        handle: providerHandle,
        origin: 'adopted',
        mintedAtFence: fence,
        observedAt: 1
      }
    ]
  })
  await seedTestAgentSessionRecordStore(root, {
    records: [{ ...record, lease: { ...record.lease, runtimeFence: fence } }]
  })
  const store = await openTestAgentSessionRecordStore(root)
  const now = Date.now()
  const operationId = `${now}-00000000000000000000000000000001`
  const callerKey = 'rewind-fixture'
  const admission = await store.admitOperation({
    callerKey,
    operationId,
    fingerprint: 'rewind',
    now
  })
  if (admission.decision !== 'admit') {
    throw new Error('rewind fixture could not admit its operation')
  }
  await store.updateRecord(sessionId, {
    kind: 'rewind',
    fence,
    rewind: {
      operationId,
      callerKey,
      itemId,
      expectedEpoch: journal.cursor().epoch,
      phase: 'provider-succeeded',
      ...(provider === 'claude'
        ? {
            providerFork: {
              sessionId: 'fixture-fork',
              sourceSessionId: providerHandle.nativeId,
              replacesSessionId: providerHandle.nativeId,
              materialized: true
            }
          }
        : {})
    }
  })
  const recoveredStore = await openTestAgentSessionRecordStore(root, { mode: 'observe' })
  await recoverStructuredRewind(
    { store: recoveredStore, logger: testEventSinkLogging().logger },
    sessionId,
    journal,
    fence
  )
  return {
    record: recoveredStore.getRecord(sessionId),
    outcome: recoveredStore.getOperationRow(callerKey, operationId)?.outcome
  }
}
