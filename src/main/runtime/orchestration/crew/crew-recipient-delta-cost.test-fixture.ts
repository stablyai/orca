import { expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as profileStorage from '../../../orca-profiles/profile-storage-paths'
import {
  pendingAgentSessionOperationRow,
  agentSessionOperationKey
} from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { isAgentSessionLaunchArgs } from '../../../../shared/agent-session/lifecycle/agent-session-launch-args'
import * as runtimeRecords from '../../agent-session/records/agent-session-runtime-end-record'
import { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import { JournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database'
import {
  releaseAgentSessionRecordStore,
  peekOpenedAgentSessionRecordStore
} from '../../agent-session/records/agent-session-record-store-slot'
import { createSessionCallerHarness } from '../../rpc/orchestration-session-caller-test-fixture'
import { ORCHESTRATION_CREW_METHODS } from '../../rpc/methods/orchestration/crew-methods'
import { CrewFrame, type OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import { LEGACY_CONTRACT_VERSION, LEGACY_RUN_ID } from '../db/contract-constants'
import { fixture } from './crew-read-model.test-fixture'

export const SELF = testOrcaSessionId('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
export const TARGET = testOrcaSessionId('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
export const address = formatOrcaSessionAddress
export const crewRecord = (sessionId: string) =>
  agentSessionConversationView(agentSessionRecordFixture({ sessionId }))

export function deltaFixture(peers = 0) {
  const f = fixture()
  const records = new Map([[SELF.toString(), crewRecord(SELF)]])
  for (let i = 0; i < peers; i++) {
    const id = testOrcaSessionId(`chat-delta-${i}`)
    records.set(id, crewRecord(id))
    f.db.insertMessage({ from: address(id), to: address(SELF), subject: 'Peer', body: `peer ${i}` })
  }
  const visible = new Set(records.keys())
  f.deps.records = {
    listRecords: () => [...records.values()],
    getRecord: (id) => records.get(id) ?? null,
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [...visible] })
  }
  return { ...f, records, visible }
}

export function retainedLegacy(f: ReturnType<typeof deltaFixture>, count: number, owner?: string) {
  const at = '2099-01-01 00:00:00'
  // Supported retained migration state; not a fresh ordinary producer frequency claim.
  f.db.db
    .prepare(
      'INSERT INTO legacy_adoptions (source_run_id, adopted_run_id, scheduler_state_lost, adopted_at) VALUES (?, ?, 1, ?)'
    )
    .run(LEGACY_RUN_ID, f.run.id, at)
  f.db.db
    .prepare(
      "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, scheduler_lost_at) VALUES (?, ?, 'failed', ?, ?)"
    )
    .run('retained-delta', 'retained coordinator', owner ?? 'term_legacy_coord', at)
  for (let i = 0; i < count; i++) {
    const handle = `term_legacy_worker_${i}`
    const task = f.db.createTask({ runId: f.run.id, spec: 'retained legacy worker' })
    const dispatch = f.db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: handle,
      creator: { kind: 'system' },
      maxDepth: 10
    })
    f.db.db
      .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id = ?')
      .run(LEGACY_CONTRACT_VERSION, dispatch.id)
    f.db.insertMessage({
      runId: f.run.id,
      deliveryContract: 'legacy_direct',
      from: handle,
      to: owner ?? `term_legacy_peer_${i}`,
      subject: 'retained',
      body: 'retained legacy mail'
    })
  }
}

export function remembered(f: ReturnType<typeof deltaFixture>, id = TARGET, count = 2) {
  const runs = Array.from({ length: count }, (_, i) =>
    f.db.createRun({
      objective: `history ${i}`,
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: id
    })
  )
  f.db.unbindOtherRunsForCoordinator(
    { terminalHandle: null, paneKey: null, orcaSessionId: id },
    f.run.id
  )
  return runs
}

// Saved sessions load once, in a fixed number of statements, as their count grows tenfold.
export async function runColdCrewCostProfiles(clearHost: () => void) {
  for (const n of [3, 30]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-cold-cost-'))
    const path = vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(directory)
    const h = createSessionCallerHarness({ current: null })
    clearHost()
    const seed = await h.runtime.openAgentSessionRecordStore()
    const ids = Array.from({ length: n }, () => randomUUID())
    const text = 'x'.repeat(128)
    expect(isAgentSessionLaunchArgs([text])).toBe(true)
    for (const [i, sessionId] of ids.entries()) {
      await seed.founding.commit({
        sessionId,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder-worker-host',
          workspaceKind: 'folder'
        },
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: '/unused-private-fixture-account-home' },
        surfaceTabId: `tab_saved_${i}`,
        expectedFence: null,
        spawnToken: 'unused-at-rest',
        claimKeyId: 'private-cold-claim',
        handoffOperationId: null,
        probe: { outcome: 'indeterminate', reason: 'at-rest creation starts no process' },
        operation: {
          callerKey: 'private-cold',
          operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
          fingerprint: `found:${sessionId}`
        },
        now: Date.now()
      })
    }
    const released = await releaseAgentSessionRecordStore()
    if (!released) {
      throw new Error('Expected fixture-owned seeded slot')
    }
    const stateDirectory = released.journalDatabase.stateDirectory
    const savedDb = released.journalDatabase.db
    // Retained valid launch arguments are loaded, never executed by this fixture.
    savedDb
      .prepare(
        "UPDATE agent_session_records SET record_json = json_set(record_json, '$.launchArgs', json(?))"
      )
      .run(JSON.stringify([text]))
    const operationIds: string[] = []
    const j = 3
    // Independent retained replay/key rows; use the production key and row constructor.
    savedDb.prepare('DELETE FROM agent_session_operations').run()
    for (let i = 0; i < j; i++) {
      const row = pendingAgentSessionOperationRow({
        callerKey: 'private-cold',
        operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
        fingerprint: `saved:${i}`,
        now: Date.now()
      })
      operationIds.push(row.operationId)
      savedDb
        .prepare('INSERT INTO agent_session_operations (operation_key, row_json) VALUES (?, ?)')
        .run(agentSessionOperationKey(row.callerKey, row.operationId), JSON.stringify(row))
      savedDb
        .prepare('INSERT INTO agent_session_retired_claim_keys (key_id, retired_at) VALUES (?, ?)')
        .run(`retired-${i}`, Date.now())
    }
    released.journalDatabase.close()
    const runtimeDirectory = join(stateDirectory, 'agent-session-runtimes')
    mkdirSync(runtimeDirectory, { recursive: true })
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(runtimeDirectory, `saved-${i}.json`),
        JSON.stringify({ runtime: `saved-${i}`, startedAt: 1, end: { trigger: 'quit', at: 2 } })
      )
    }
    expect(readdirSync(runtimeDirectory)).toHaveLength(3)
    const runtimeRead = vi.spyOn(runtimeRecords, 'readAgentSessionRuntimeEnds')
    const runtimeBegin = vi.spyOn(runtimeRecords, 'beginAgentSessionRuntimeRecord')
    const actualOpen = AgentSessionRecordStore.open
    const cold: ReturnType<typeof meterCrewSql>['executions'] = []
    const opens = vi.spyOn(AgentSessionRecordStore, 'open').mockImplementation((args) => {
      const meter = meterCrewSql(args.journalDatabase.db)
      meter.control.phase = 'cold-store-load'
      try {
        return actualOpen(args)
      } finally {
        cold.push(...meter.executions)
        meter.restore()
      }
    })
    const journalOpen = vi.spyOn(JournalHostDatabase, 'open')
    h.db.insertMessage({
      from: `orca_session_id:${ids[1]}`,
      to: `orca_session_id:${ids[0]}`,
      subject: 'saved peer',
      body: 'cold L'
    })
    const controllers: AbortController[] = []
    const subscriptions: Promise<void>[] = []
    try {
      for (let request = 0; request < 2; request++) {
        const controller = new AbortController()
        controllers.push(controller)
        const received: OrchestrationCrewFrame[] = []
        const completed = Promise.withResolvers<void>()
        subscriptions.push(
          ORCHESTRATION_CREW_METHODS[0].handler(
            { party: `orca_session_id:${ids[0]}` },
            { runtime: h.runtime, signal: controller.signal },
            (value) => {
              const frame = CrewFrame.parse(value)
              received.push(frame)
              if (frame.type === 'complete') {
                completed.resolve()
              }
            }
          )
        )
        await completed.promise
        expect(received[0]).toEqual({ type: 'begin', status: 'ok' })
        expect(
          received
            .flatMap((frame) => (frame.type === 'rows' ? frame.rows : []))
            .find((row) => row.latest?.preview === 'cold L')?.sendAddress
        ).toBe(`orca_session_id:${ids[1]}`)
      }
      const opened = peekOpenedAgentSessionRecordStore()
      expect(opened).not.toBeNull()
      expect(await h.runtime.openAgentSessionRecordStore()).toBe(opened)
      expect(opens).toHaveBeenCalledOnce()
      expect(journalOpen).toHaveBeenCalledOnce()
      expect(opened?.listRecords()).toHaveLength(ids.length)
      expect(opened?.getVisibleSessionTabIndex().sessionIds).toHaveLength(ids.length)
      expect(runtimeRead).toHaveBeenCalledOnce()
      expect(runtimeBegin).toHaveBeenCalledOnce()
      expect(runtimeRead.mock.results[0].value?.size).toBe(3)
      expect(h.runtime.ensureStructuredAgentSessionHost).not.toHaveBeenCalled()
      const totals = sqlTotals(cold)
      expect(totals).toMatchObject({ get: 2, all: 4, run: 0, iterate: 0 })
      expect(
        cold.find((row) => row.sql.includes('record_json FROM agent_session_records'))?.rows
      ).toBe(ids.length)
      expect(
        cold.find((row) => row.sql.includes('row_json FROM agent_session_operations'))?.rows
      ).toBe(j)
      expect(
        cold.find((row) => row.sql.includes('FROM agent_session_retired_claim_keys'))?.rows
      ).toBe(j)
      for (const operationId of operationIds) {
        expect(opened?.getOperationRow('private-cold', operationId)?.outcome).toEqual({
          status: 'pending'
        })
      }
    } finally {
      controllers.forEach((controller) => controller.abort())
      await Promise.all(subscriptions)
      const opened = await releaseAgentSessionRecordStore()
      opened?.journalDatabase.close()
      runtimeRead.mockRestore()
      runtimeBegin.mockRestore()
      opens.mockRestore()
      journalOpen.mockRestore()
      path.mockRestore()
    }
  }
}
