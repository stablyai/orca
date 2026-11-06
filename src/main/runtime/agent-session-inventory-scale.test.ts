import { describe, expect, it, vi } from 'vitest'
import { composeWorktreeHostIdentity } from '../../shared/worktree/host-qualified-identity'
import '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import '../ai-vault/structured-session-ownership.test-support'
import '../ai-vault/structured-session-ownership'
import { hostTestState } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  countRecordQueries,
  countStoreWork,
  scaleJournal,
  scaleStore,
  scaleDirectory,
  scaleRecord
} from './agent-session-scale.test-fixture'
import { findWorkspaceReferences } from './runtime-reference-find'
import { parseWorkspaceReferenceUrl } from '../../shared/workspace-attachments/workspace-reference-identity'
import { createReferenceAgentIndex } from './runtime-reference-agents'
import {
  seedTestAgentSessionRecordStore,
  openTestAgentSessionRecordStore,
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStore
} from './agent-session/records/agent-session-record-store-test-harness'
import { OrchestrationDb } from './orchestration/db/orchestration-db'
import './orchestration/db/contract-constants'
import './orchestration/db/messages/mailbox-routing-page'
import './orchestration/db/dispatch-row-writer'
import './orchestration/db/attempt-outcome-projection'
import { structuredSessionMailReach } from './orchestration/mailbox/routing/structured-session-mail-address'
import { resolveOrcaSessionParty } from './orchestration/addressing/orchestration-party'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  openAgentSessionRecordStoreOnce,
  releaseAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-slot'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { conversationRecordReader } from './orchestration/addressing/session-lineage/structured-session-lineage'
import './agent-session/structured-agent-session-create-adoption'
import { listStructuredSessionsForWorktree } from './workspaces/removal/structured-session-worktree-teardown'
import * as membership from './agent-session/records/agent-session-store-state'

// Uses the complete host harness; discovery, mail reach and every store read execute unchanged.
async function inventoryRig(n: number) {
  const rig = await scaleStore(n)
  const host = new StructuredAgentSessionHost({
    ...hostTestState().host.deps,
    store: rig.store,
    journalDatabase: openTestJournalHostDatabase(rig.root)
  })
  setStructuredAgentSessionHost(host)
  return { ...rig, host }
}

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

describe('real conversation inventory work', () => {
  it.each([10, 100])('visits %i unreadable rows once per audience inventory', async (u) => {
    const root = await scaleDirectory()
    const healthy = Array.from({ length: 10 }, (_, i) => scaleRecord(`healthy-u-${i}`))
    const unreadable = Array.from({ length: u }, (_, i) => scaleRecord(`unreadable-u-${i}`))
    const retained = unreadable.filter((_, i) => i % 2 === 0)
    await seedTestAgentSessionRecordStore(root, {
      records: [...healthy, ...unreadable],
      sessionTabs: [...healthy, ...unreadable].map(({ sessionId }) => ({
        sessionId,
        tabId: `tab-${sessionId}`
      }))
    })
    await editPersistedTestAgentSessionStore(root, (state) => {
      unreadable.forEach(({ sessionId }, i) => {
        if (i % 2 === 0) {
          Object.assign(state.records[sessionId].lease, { minimumNextFence: 'bad' })
        } else {
          Object.assign(state.records[sessionId], { providerHandleChain: 'bad' })
        }
      })
    })
    const raw = await readPersistedTestAgentSessionStore(root)
    const store = await openTestAgentSessionRecordStore(root)
    const host = new StructuredAgentSessionHost({
      ...hostTestState().host.deps,
      store,
      journalDatabase: openTestJournalHostDatabase(root)
    })
    const ids = new Set(unreadable.map(({ sessionId }) => sessionId))
    const work = countStoreWork(store)
    const inventories = vi.mocked(store.listConversations)
    // Default spy executes native flatMap and its production callback on every dense input row.
    const flatten = vi.spyOn(Array.prototype, 'flatMap')
    try {
      for (let repeat = 1; repeat <= 3; repeat++) {
        expect(host.knownAgentIds()).toContain('claude')
        expect(work.counts).toMatchObject({
          inventories: repeat,
          views: 10 * repeat,
          clones: 0,
          decodes: 0
        })
      }
      const scans = flatten.mock.contexts
        .map((rows, i) =>
          Array.isArray(rows) &&
          rows.length === u &&
          rows.every(
            (row: unknown) =>
              typeof row === 'object' &&
              row !== null &&
              'raw' in row &&
              typeof row.raw === 'object' &&
              row.raw !== null &&
              'sessionId' in row.raw &&
              typeof row.raw.sessionId === 'string' &&
              ids.has(row.raw.sessionId)
          )
            ? i
            : -1
        )
        .filter((i) => i >= 0)
      expect(scans).toHaveLength(3)
      for (const i of scans) {
        expect(flatten.mock.contexts[i]).toMatchObject(
          unreadable.map(({ sessionId }) => ({ raw: { sessionId } }))
        )
        expect(flatten.mock.results[i]).toEqual({
          type: 'return',
          value: retained.map(({ sessionId }) => store.getConversation(sessionId))
        })
      }
      expect(inventories.mock.results.map((result) => result.value)).toEqual(
        Array.from({ length: 3 }, () =>
          [...healthy, ...retained].map(({ sessionId }) => store.getConversation(sessionId))
        )
      )
    } finally {
      flatten.mockRestore()
    }
    expect(store.getVisibleSessionTabIndex().sessionIds).toEqual(
      [...healthy, ...retained].map(({ sessionId }) => sessionId)
    )
    for (const [i, { sessionId }] of unreadable.entries()) {
      expect(store.getConversation(sessionId)?.sessionId ?? null).toBe(i % 2 ? null : sessionId)
      expect(store.getRecord(sessionId)).toBeNull()
      expect(() => store.requireWritableRecord(sessionId)).toThrow()
    }
    await store.setConversationName(healthy[0]!.sessionId, 'unrelated update')
    const after = await readPersistedTestAgentSessionStore(root)
    for (const { sessionId } of unreadable) {
      expect(after.records[sessionId]).toEqual(raw.records[sessionId])
    }
  })

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
      journalDatabase: openTestJournalHostDatabase(globalRoot)
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
      logger: createStructuredAgentSessionLogger()
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
      const released = await releaseAgentSessionRecordStore()
      await released?.journalDatabase.close()
    }
  })

  it.each([10, 100])(
    'finds all references at %i rows without allocating membership payloads',
    async (n) => {
      const rig = await inventoryRig(n)
      const work = countStoreWork(rig.store)
      const queries = countRecordQueries(rig.root)
      const visits = vi.spyOn(membership, 'hasAgentSessionConversation')
      let index: ReturnType<typeof createReferenceAgentIndex> = new Map()
      const result = await findWorkspaceReferences(
        { query: 'STA-1234' },
        {
          workspaces: ['workspace-1', 'other'].map((id) => ({
            id,
            hostId: 'local' as const,
            name: id,
            repo: 'repo',
            kind: 'worktree' as const,
            isArchived: false,
            linkedItems: [parseWorkspaceReferenceUrl('https://linear.app/acme/issue/STA-1234')]
          })),
          agents: (workspaceKeys) => {
            index = createReferenceAgentIndex(
              referenceRuntime,
              null,
              conversationRecordReader(rig.store),
              workspaceKeys
            )
            return index
          }
        }
      )
      expect(result.matches.flatMap((match) => match.agents)).toHaveLength(n + 1)
      const found = [...index.values()].flat()
      expect(found.map((row) => row.sessionId).sort()).toEqual(
        rig.rows
          .filter((row) => !['closed-chat', 'malformed-chat'].includes(row.sessionId))
          .map((row) => row.sessionId)
          .sort()
      )
      expect(index.get(composeWorktreeHostIdentity('local', 'workspace-1'))).toHaveLength(n / 2 + 1)
      expect(found.every((row) => row.liveness === 'unverifiable')).toBe(true)
      expect(found.find((row) => row.sessionId === 'damaged-chat')?.sessionIds).toContain(
        'provider-damaged-chat-0'
      )
      expect(work.counts).toMatchObject({
        views: 4 * n + 2,
        inventories: 2,
        keyed: 2 * (n + 1),
        // Each mail-reach check asks the keyed retirement read; one index read remains.
        tabReads: 1,
        clones: 0,
        decodes: 0
      })
      // Keyed: the visible-tab list built once, then one membership question per row.
      expect(visits).toHaveBeenCalledTimes(2 * n + 3)
      expect(queries()).toEqual({ executions: 0, rows: 0 })
      work.reset()
      visits.mockClear()
      expect(rig.store.getVisibleSessionTabIndex().sessionIds).toHaveLength(n + 1)
      await rig.store.showSessionTabs([
        'closed-chat',
        'damaged-chat',
        'malformed-chat',
        'missing-chat'
      ])
      expect(rig.store.getVisibleSessionTabIndex().sessionIds).toContain('closed-chat')
      expect(rig.store.getVisibleSessionTabIndex().sessionIds).not.toContain('malformed-chat')
      expect(work.counts.views).toBe(0)
      await expect(rig.store.setSessionTabVisibility('malformed-chat', true)).rejects.toThrow()
      expect(work.counts.views).toBe(0)
    }
  )

  it.each([10, 100])(
    'seeds selected records without opening journals and scopes lifecycle inventory at %i rows',
    async (n) => {
      const rig = await inventoryRig(n)
      for (const id of ['damaged-chat', rig.rows[0]!.sessionId, rig.rows[1]!.sessionId]) {
        await (await scaleJournal(rig.root, id)).close()
      }
      const work = countStoreWork(rig.store)
      const queries = countRecordQueries(rig.root)
      const openJournal = vi.spyOn(journalFactory, 'openAgentSessionJournal')
      await rig.host.seedSessionTabs(['damaged-chat', rig.rows[0]!.sessionId])
      expect(openJournal).not.toHaveBeenCalled()
      expect(rig.host.hasSession(rig.rows[0]!.sessionId)).toBe(false)
      expect(work.counts).toMatchObject({ inventories: 0, views: 1, keyed: 2, clones: 0 })
      work.reset()
      const scoped = listStructuredSessionsForWorktree('workspace-1', {
        resolvedConnectionId: null
      })
      expect(scoped.members).toHaveLength(n / 2 + 2)
      expect(scoped.live).toEqual([])
      expect(scoped.members.some((row) => row.sessionId === 'damaged-chat')).toBe(true)
      expect(work.counts).toMatchObject({ inventories: 1, views: n + 1 + n / 2 + 1, clones: 0 })
      work.reset()
      const slept = await rig.host.sleepWorkspace('workspace-1')
      expect(slept.stoppedSessionIds).not.toContain('damaged-chat')
      expect(slept.failures?.some((row) => row.sessionId === 'damaged-chat')).toBe(true)
      expect(work.counts.inventories).toBe(1)
      // One inventory and six checked observations per selected healthy member.
      expect(work.counts.views).toBe(n + 1 + 6 * (n / 2 + 1))
      expect(rig.store.getConversation(rig.rows[1]!.sessionId)?.location.workspaceId).toBe('other')
      work.reset()
      expect(rig.host.knownAgentIds()).toContain('claude')
      expect(work.counts).toMatchObject({ inventories: 1, views: n + 1, clones: 0 })
      expect(queries()).toEqual({ executions: 0, rows: 0 })
      expect(hostTestState().acquire).not.toHaveBeenCalled()
    }
  )
})
