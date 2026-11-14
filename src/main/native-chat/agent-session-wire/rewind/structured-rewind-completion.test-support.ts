import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { testEventSinkLogging } from '../host/testing/structured-agent-session-logger.test-fixture'
import { recoverStructuredRewind } from './structured-rewind-recovery'

/** Complete the saved provider mutation through the real atomic journal/record receipt. */
export async function completeTestJournalRewind(
  root: string,
  journal: AgentSessionJournal,
  itemId: string,
  fence = 1
): Promise<void> {
  const { sessionId, agent: provider, providerHandle } = journal.identity
  if (!providerHandle || (provider !== 'claude' && provider !== 'codex')) {
    throw new Error('rewind fixture requires a native provider handle')
  }
  const record = agentSessionRecordFixture({
    sessionId,
    provider,
    providerHandleChain: [
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
  const operationId = '1700000000000-00000000000000000000000000000001'
  const callerKey = 'rewind-fixture'
  await store.admitOperation({ callerKey, operationId, fingerprint: 'rewind', now: 1_000 })
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
  await recoverStructuredRewind(
    { store, logger: testEventSinkLogging().logger },
    sessionId,
    journal,
    fence
  )
}
