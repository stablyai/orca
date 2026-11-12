import { describe, expect, it } from 'vitest'
import '../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import '../../../ai-vault/structured-sessions/structured-session-ownership.test-support'
import '../../../ai-vault/structured-sessions/structured-session-ownership'
import { hostTestState } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import { createReferenceAgentIndex } from '../../workspaces/references/runtime-reference-agents'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from './agent-session-record-store-test-harness'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { structuredSessionMailReach } from '../../orchestration/mailbox/routing/structured-session-mail-address'
import { resolveOrcaSessionParty } from '../../orchestration/addressing/orchestration-party'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  openAgentSessionRecordStoreOnce,
  retireAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { conversationRecordReader } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import '../structured-agent-session-create-adoption'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'

const referenceRuntime = {
  getOrchestrationFleetAgentStatusSnapshot: () => [],
  getAgentProviderSessionRows: () => [],
  getTerminalLivenessVerdict: () => null
}

function clearedRecord(sessionId: string, successor: string): AgentSessionRecord {
  return {
    ...scaleRecord(sessionId),
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      replacementSessionId: successor,
      operationId: `clear-${sessionId}`,
      callerKey: 'client',
      phase: 'committed'
    }
  }
}

describe('persisted conversation inventory identity', () => {
  it('keeps global worker identity separate from candidate inventory and retains closure/loop outcomes', async () => {
    const rootId = testOrcaSessionId('global-root')
    const successor = testOrcaSessionId('visible-successor')
    const globalRoot = await scaleDirectory()
    const candidateRoot = await scaleDirectory()
    const rows = [
      scaleRecord(successor),
      scaleRecord('closed-chat'),
      clearedRecord('loop-one', 'loop-two'),
      clearedRecord('loop-two', 'loop-one')
    ]
    const sessionTabs = [
      { tabId: 'successor-tab', sessionId: successor },
      { tabId: 'loop-tab', sessionId: 'loop-one' }
    ]
    await seedTestAgentSessionRecordStore(globalRoot, {
      records: [clearedRecord(rootId, successor), ...rows],
      sessionTabs
    })
    await seedTestAgentSessionRecordStore(candidateRoot, { records: rows, sessionTabs })
    const globalStore = await openTestAgentSessionRecordStore(globalRoot)
    const candidateStore = await openTestAgentSessionRecordStore(candidateRoot)
    const host = new StructuredAgentSessionHost({
      ...hostTestState().host.deps,
      store: globalStore,
      journalDatabase: await openTestAgentSessionDatabase(globalRoot)
    })
    setStructuredAgentSessionHost(host)
    const db = new OrchestrationDb(':memory:')
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(rootId)
    try {
      const run = db.createRun({
        objective: 'identity control',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const dispatch = db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'saved worker' }).id,
        assigneeHandle: handle,
        assigneePaneKey: paneKey,
        processIncarnation: structuredWorkerProcessIncarnation(rootId),
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER
      })
      expect(db.getDispatchContextById(dispatch.id)?.assignee_orca_session_id).toBe(rootId)
      const reader = conversationRecordReader(candidateStore)
      const found = () =>
        [...createReferenceAgentIndex(referenceRuntime, db, reader).values()].flat()
      expect(candidateStore.getConversation(rootId)).toBeNull()
      expect(found()).toMatchObject([{ sessionId: successor, liveness: 'unverifiable' }])
      expect(found()[0]?.mailbox).toBeUndefined()
      expect(
        structuredSessionMailReach(reader, candidateStore.getConversation(successor)!, db)
      ).toEqual({ kind: 'ended', reason: 'worker-identity-lost' })
      structuredWorkerIdentities.register({
        handle,
        paneKey,
        sessionId: rootId,
        agent: 'claude',
        processIncarnation: structuredWorkerProcessIncarnation(rootId),
        worktreeId: 'workspace-1',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      expect(resolveOrcaSessionParty(successor, db)).toMatchObject({
        orcaSessionId: rootId,
        terminalHandle: handle
      })
      expect(found()[0]?.mailbox).toBe(`orca_session_id:${successor}`)
      expect(
        structuredSessionMailReach(reader, candidateStore.getConversation('closed-chat')!, db)
      ).toEqual({ kind: 'ended', reason: 'closed' })
      expect(
        structuredSessionMailReach(reader, candidateStore.getConversation('loop-one')!, db)
      ).toMatchObject({ kind: 'unverifiable', reason: expect.stringContaining('loops') })
      await candidateStore.setSessionTabVisibility(successor, false)
      expect(found()).toEqual([])
    } finally {
      structuredWorkerIdentities.forget(handle)
      db.close()
    }
  })

  it('uses the opened cold inventory without importing its predecessor into absent global identity', async () => {
    const root = await scaleDirectory()
    const predecessor = testOrcaSessionId('cold-root')
    const successor = testOrcaSessionId('cold-successor')
    await seedTestAgentSessionRecordStore(root, {
      records: [clearedRecord(predecessor, successor), scaleRecord(successor)],
      sessionTabs: [{ tabId: 'cold-tab', sessionId: successor }]
    })
    const opened = await openAgentSessionRecordStoreOnce({
      legacySessionTabIds: [],
      stateDirectory: root,
      hostId: 'local',
      logger: createStructuredAgentSessionLogger(),
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath()
    })
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'cold identity',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'predecessor' }).id,
        assigneeHandle: mintStructuredWorkerHandle(),
        processIncarnation: structuredWorkerProcessIncarnation(predecessor),
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER
      })
      for (const index of [
        createReferenceAgentIndex(referenceRuntime, db),
        createReferenceAgentIndex(referenceRuntime, db, conversationRecordReader(opened.store))
      ]) {
        expect([...index.values()].flat()).toMatchObject([
          {
            sessionId: successor,
            mailbox: `orca_session_id:${successor}`,
            liveness: 'unverifiable'
          }
        ])
      }
      expect(resolveOrcaSessionParty(successor, db)).toMatchObject({
        orcaSessionId: successor,
        terminalHandle: null
      })
    } finally {
      db.close()
      await retireAgentSessionRecordStore(async (released) => {
        await released?.journalDatabase.close()
      })
    }
  })
})
