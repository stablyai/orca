import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import { listResult } from './structured-session-ownership.test-support'
import { parseAiVaultListResult } from './session-list-result-validation'
import { restampAiVaultListResult } from './session-list-results'
import { aiVaultOrchestrationChildSessionIds } from './structured-conversation-navigation'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../runtime/structured-worker-identity'

const EMPTY: AiVaultListResult = { sessions: [], issues: [], scannedAt: '2026-10-25T00:00:00Z' }

function install(records: readonly AgentSessionRecord[]): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list projection reads only the durable catalog on this host.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        listRecords: () => records,
        hostId: 'local',
        getRecord: (id: string) => records.find((record) => record.sessionId === id) ?? null,
        listConversations: () => records.map(agentSessionConversationView)
      }
    }
  } as never)
}

function retained(provider = 'claude'): AgentSessionRecord {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'released',
      ownerProcess: null,
      provenHandleLinkId: null
    })
  )
  return {
    ...record,
    provider,
    providerHandleChain: [],
    location: { ...record.location, workspaceId: 'folder:notes', workspaceKind: 'folder' },
    launchDirectory: '/notes',
    conversationName: 'Saved conversation',
    createdAt: Date.parse('2026-10-23T00:00:00Z'),
    updatedAt: Date.parse('2026-10-24T12:00:00Z')
  }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('primary conversation navigation from the durable session catalog', () => {
  it('distinguishes absent orchestration history from an unreadable custody database', () => {
    expect(aiVaultOrchestrationChildSessionIds(null)?.size).toBe(0)
    expect(
      aiVaultOrchestrationChildSessionIds(() => {
        throw new Error('database open failed')
      })
    ).toBeNull()
  })

  it('keeps the conversation list available when child custody lookup fails', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      vi.spyOn(db, 'hasAnyDispatchContexts').mockReturnValue(true)
      const prepare = db.db.prepare.bind(db.db)
      const spy = vi
        .spyOn(db.db, 'prepare')
        .mockImplementation(() => prepare('SELECT NULL AS sessionId'))
      expect(aiVaultOrchestrationChildSessionIds(db)).toBeNull()
      spy.mockImplementation(() => {
        throw new Error('custody database unavailable')
      })
      expect(aiVaultOrchestrationChildSessionIds(db)).toBeNull()
    } finally {
      db.close()
    }
  })
  it('keeps provider history but does not project retained children without custody evidence', () => {
    install([retained()])
    const providerList = listResult()
    const projected = projectStructuredAiVaultSessions(providerList, OPENS_EVERY_STRUCTURED_CHAT, {
      includeStructuredSessions: true,
      childSessionIds: null
    })
    expect(projected.sessions).toEqual(providerList.sessions)
    expect(projected).not.toHaveProperty('includesStructuredSessions')
  })

  it('keeps released worker journals inside the parent using existing orchestration custody records', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const parent = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
      const worker = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
      const run = db.createRun({
        objective: 'Inspect',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: parent
      })
      const started = db.createStartingWorkerDispatch({
        taskSpec: 'Worker',
        taskRunId: run.id,
        startOptions: {},
        creator: { kind: 'session', orcaSessionId: parent },
        maxDepth: 10
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: mintStructuredWorkerHandle(),
        paneKey: mintStructuredWorkerPaneKey(worker),
        processIncarnation: structuredWorkerProcessIncarnation(worker),
        worktreeId: 'folder:notes',
        effects: [],
        setupState: 'ready',
        terminalOwnership: 'created'
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      db.settleWorkerReport({
        taskId: started.task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: 'Done'
      })
      const resource = db.getWorkerTerminalResourceByOwner(started.dispatch.id)!
      db.settleDeadWorkerTerminalRelease({
        requestingDispatchId: started.dispatch.id,
        resourceId: resource.id,
        processIncarnation: resource.process_incarnation!
      })
      const successor = testOrcaSessionId('561bb50e-6281-43a7-a761-4e15dc4c730a')
      const records: AgentSessionRecord[] = [parent, worker, successor].map((sessionId) => ({
        ...retained(),
        sessionId
      }))
      records[1]!.conversationCommand = {
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        operationId: 'clear-worker',
        callerKey: 'worker',
        replacementSessionId: successor
      }
      install(records)
      expect(
        projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
          includeStructuredSessions: true,
          childSessionIds: aiVaultOrchestrationChildSessionIds(db)
        }).sessions.map((row) => row.structuredSession?.sessionId)
      ).toEqual([parent])
    } finally {
      db.close()
    }
  })
  it.each(['chat', 'structured-worker'] as const)(
    'keeps directly assigned %s conversations inside the parent without terminal custody',
    (kind) => {
      const db = new OrchestrationDb(':memory:')
      try {
        const parent = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
        const worker = testOrcaSessionId('7e3b9d15-2c4a-4f86-a0b1-5c9e2d7f3b64')
        const standalone = testOrcaSessionId('561bb50e-6281-43a7-a761-4e15dc4c730a')
        const run = db.createRun({
          objective: 'Adopt an existing conversation',
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorOrcaSessionId: parent
        })
        const dispatch = db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'Inspect' }).id,
          ...(kind === 'chat'
            ? { assigneeHandle: formatOrcaSessionAddress(worker) }
            : {
                assigneeHandle: mintStructuredWorkerHandle(),
                assigneePaneKey: mintStructuredWorkerPaneKey(worker),
                processIncarnation: structuredWorkerProcessIncarnation(worker)
              }),
          creator: { kind: 'session', orcaSessionId: parent },
          maxDepth: 10
        })
        expect(dispatch).toMatchObject({
          assignee_orca_session_id: worker,
          creator_orca_session_id: parent
        })
        expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toBeUndefined()
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'Coordinator bookkeeping' }).id,
          assigneeHandle: formatOrcaSessionAddress(parent),
          creator: { kind: 'session', orcaSessionId: parent },
          maxDepth: 10
        })
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'Root assignment' }).id,
          assigneeHandle: formatOrcaSessionAddress(standalone),
          creator: { kind: 'system' },
          maxDepth: 10
        })
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'Legacy terminal' }).id,
          assigneeHandle: 'term_without_session_identity',
          creator: { kind: 'session', orcaSessionId: parent },
          maxDepth: 10
        })
        const records = [parent, worker, standalone].map((sessionId) => ({
          ...retained(),
          sessionId
        }))
        install(records)
        const topLevel = () =>
          projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
            includeStructuredSessions: true,
            childSessionIds: aiVaultOrchestrationChildSessionIds(db)
          }).sessions.map((row) => row.structuredSession?.sessionId)
        expect(aiVaultOrchestrationChildSessionIds(db)).toEqual(new Set([worker]))
        expect(topLevel()).toEqual([parent, standalone])
        expect(
          db.settleWorkerReport({
            taskId: dispatch.task_id,
            dispatchId: dispatch.id,
            outcome: 'succeeded',
            result: 'Done'
          })
        ).toMatchObject({ action: 'settled' })
        expect(aiVaultOrchestrationChildSessionIds(db)).toEqual(new Set([worker]))
        expect(topLevel()).toEqual([parent, standalone])
      } finally {
        db.close()
      }
    }
  )

  it.each(['claude', 'codex'])(
    'retains an empty %s chat without a provider handle or file, without changing transcript browsing',
    (provider) => {
      const record = retained(provider)
      install([record])
      expect(projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT)).toBe(EMPTY)
      const result = projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
        includeStructuredSessions: true
      })
      expect(result.sessions).toEqual([
        expect.objectContaining({
          source: 'structured-record',
          agent: provider,
          title: record.conversationName,
          cwd: '/notes',
          filePath: '',
          resumeCommand: '',
          createdAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-24T12:00:00.000Z',
          structuredSession: { sessionId: record.sessionId, workspaceId: 'folder:notes' }
        })
      ])
      expect(
        projectStructuredAiVaultSessions(EMPTY, () => false, { includeStructuredSessions: true })
          .sessions
      ).toEqual([])
      expect(
        parseAiVaultListResult(restampAiVaultListResult(result, 'runtime:remote')).sessions[0]
      ).toMatchObject({
        source: 'structured-record',
        executionHostId: 'runtime:remote',
        structuredSession: { sessionId: record.sessionId }
      })
    }
  )

  it('deduplicates all provider handles and duplicate files by stored chat while preserving another host', () => {
    const record = retained()
    record.providerHandleChain = ['provider-first', 'provider-latest'].map((id, index) => ({
      linkId: `link-${index}`,
      origin: 'created',
      mintedAtFence: index + 1,
      observedAt: index + 1,
      handle: claudeProviderHandle(id, null)
    }))
    install([record])
    const base = listResult().sessions[0]!
    const files = record.providerHandleChain.map((link, index) => ({
      ...base,
      agent: 'claude' as const,
      sessionId: index === 0 ? 'provider-first' : 'provider-latest',
      id: `file-${index}`,
      filePath: `/transcripts/${link.linkId}.jsonl`,
      updatedAt: new Date(record.updatedAt + index).toISOString()
    }))
    const remote = { ...files[0]!, id: 'remote', executionHostId: 'runtime:remote' as const }
    const result = projectStructuredAiVaultSessions(
      { ...EMPTY, sessions: [...files, remote] },
      OPENS_EVERY_STRUCTURED_CHAT,
      { includeStructuredSessions: true }
    )
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions.find((row) => row.executionHostId === 'local')).toMatchObject({
      id: 'file-1',
      filePath: '/transcripts/link-1.jsonl',
      title: 'Saved conversation',
      structuredSession: { sessionId: record.sessionId }
    })
    expect(result.sessions.find((row) => row.executionHostId === 'runtime:remote')).toBe(remote)
  })

  it('never imports another execution host or WSL namespace and omits orchestration children', () => {
    const local = retained()
    const remote = {
      ...retained(),
      sessionId: 'remote-chat',
      location: { ...local.location, executionHostId: 'runtime:remote' as const }
    }
    const wsl = {
      ...retained(),
      sessionId: 'wsl-chat',
      location: { ...local.location, wslDistro: 'Ubuntu' }
    }
    const child = { ...retained(), sessionId: 'released-child' }
    install([local, remote, wsl, child])
    expect(
      projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
        includeStructuredSessions: true,
        childSessionIds: new Set([child.sessionId])
      }).sessions.map((row) => row.structuredSession?.sessionId)
    ).toEqual([local.sessionId])
  })

  it('reads live stored names and recency even when the provider scan stamp does not change', () => {
    const record = retained()
    install([record])
    const before = projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
      includeStructuredSessions: true
    })
    record.conversationName = 'Renamed after closing'
    record.updatedAt += 1000
    const after = projectStructuredAiVaultSessions(EMPTY, OPENS_EVERY_STRUCTURED_CHAT, {
      includeStructuredSessions: true
    })
    expect(after.scannedAt).toBe(before.scannedAt)
    expect(after.sessions[0]?.title).toBe('Renamed after closing')
    expect(after.sessions[0]?.updatedAt).not.toBe(before.sessions[0]?.updatedAt)
  })
})
