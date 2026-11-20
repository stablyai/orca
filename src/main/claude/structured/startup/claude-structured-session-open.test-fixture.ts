import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { seedTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { vi } from 'vitest'
import * as jsonlImport from '../../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import { chat, SESSION } from '../../transcripts/claude-transcript-catch-up.test-support'
import { adapterAtPublishFor, fakeClaude } from '../claude-structured-session-test-support'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

export async function restoredChatWithBlockedRecovery(
  cleanups: (() => Promise<void>)[],
  userSend?: true
) {
  const providerSessionId = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
  const c = await chat('batch', providerSessionId)
  await c.journal.appendItem(
    { provider: 'claude', sessionId: providerSessionId, uuid: 'unheld-turn' },
    { kind: 'turn', turnId: 'unheld-turn', state: 'running' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const record = agentSessionRecordFixture({
    sessionId: SESSION,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: c.config },
    location: { workspaceId: 'workspace' },
    providerHandleChain: [
      {
        linkId: 'saved-link',
        handle: claudeProviderHandle(providerSessionId, 'old-leaf'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 0
      }
    ]
  })
  await seedTestAgentSessionRecordStore(c.cwd, { records: [record] })
  const claude = fakeClaude({
    initSessionId: providerSessionId,
    replayUuids: ['held-echo', 'new-echo']
  })
  const adapter = adapterAtPublishFor(claude, {
    providerSessionId,
    resumeLeafUuid: 'old-leaf',
    resumesTranscript: true,
    continuesChain: true,
    cwd: c.cwd,
    claudeConfigDir: c.config
  })
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(c.cwd),
    adapter,
    journalDatabase: await openTestAgentSessionDatabase(c.cwd),
    claimKeyId: 'test-key',
    mintSpawnToken: () => 'recovery-send',
    now: () => 1_800_000_000_000
  })
  const blocked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const preparedImport = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await preparedImport(input)
    blocked.resolve()
    await release.promise
    return prepared
  })
  cleanups.push(async () => {
    release.resolve()
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
    claude.dispose()
  })
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Keep my original send' }]
  }
  const send = (clientOperationId: string, message = body) =>
    host.send(
      { callerKey: 'test-client' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body: message }
          })
        },
        body: message,
        ...(userSend ? { userSend } : {})
      }
    )
  return { ...c, host, adapter, claude, blocked: blocked.promise, release, body, send }
}
