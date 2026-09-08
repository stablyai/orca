import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

export const WORKER_HANDLE = 'term_legacy_worker'
export const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
export const COORDINATOR_HANDLE = 'term_legacy_coord'
export const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
export const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
export const CURRENT_COORDINATOR_PANE = 'tab_current_coord:55555555-5555-4555-8555-555555555555'
export const CURRENT_WORKER_HANDLE = 'term_current_worker'
export const CURRENT_WORKER_PANE = 'tab_current_worker:66666666-6666-4666-8666-666666666666'

type Transport = 'dispatch' | 'websocket'

export type LegacyCompatibilityDispatcherHarness = {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  runtime: OrcaRuntimeService
  adoptedRunId: string
  taskId: string
  dispatchId: string
  notify: ReturnType<typeof vi.spyOn>
  verify: ReturnType<typeof vi.spyOn>
}

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

export function cleanupLegacyCompatibilityDispatcherHarnesses(): void {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function createHarness(): LegacyCompatibilityDispatcherHarness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-dispatcher-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    spec: 'legacy assignment',
    createdByTerminalHandle: COORDINATOR_HANDLE
  })
  const dispatch = createRootDispatch(before, task.id, WORKER_HANDLE, WORKER_PANE)
  before.close()

  const raw = new Database(dbPath)
  raw.exec(`
    UPDATE dispatch_contexts SET process_incarnation = 'process-1';
    DROP INDEX IF EXISTS idx_messages_delivery_contract;
    DROP TABLE legacy_mail_receipts;
    DROP TABLE legacy_operation_receipts;
    DROP TABLE legacy_compatibility_principals;
    DROP TABLE legacy_adoptions;
  `)
  raw.pragma('user_version = 18')
  raw.close()

  const db = new OrchestrationDb(dbPath)
  databases.push(db)
  const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
    if (handle === COORDINATOR_HANDLE) {
      return COORDINATOR_PANE
    }
    if (handle === WORKER_HANDLE) {
      return WORKER_PANE
    }
    if (handle === CURRENT_COORDINATOR_HANDLE) {
      return CURRENT_COORDINATOR_PANE
    }
    if (handle === CURRENT_WORKER_HANDLE) {
      return CURRENT_WORKER_PANE
    }
    return null
  })
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    [WORKER_HANDLE, CURRENT_WORKER_HANDLE].includes(handle) ? 'process-1' : null
  )
  const verify = vi
    .spyOn(runtime, 'verifyOrchestrationCompatibilityCaller')
    .mockImplementation((evidence) => {
      const validWorker =
        evidence?.terminalHandle === WORKER_HANDLE && evidence.paneKey === WORKER_PANE
      const validCoordinator =
        evidence?.terminalHandle === COORDINATOR_HANDLE && evidence.paneKey === COORDINATOR_PANE
      const validCurrentCoordinator =
        evidence?.terminalHandle === CURRENT_COORDINATOR_HANDLE &&
        evidence.paneKey === CURRENT_COORDINATOR_PANE
      const validCurrentWorker =
        evidence?.terminalHandle === CURRENT_WORKER_HANDLE &&
        evidence.paneKey === CURRENT_WORKER_PANE
      if (
        (!validWorker && !validCoordinator && !validCurrentCoordinator && !validCurrentWorker) ||
        !evidence?.launchToken
      ) {
        return null
      }
      return {
        hostScope: { kind: 'local', hostId: 'local' },
        terminalHandle: evidence.terminalHandle as string,
        paneKey: evidence.paneKey as string,
        processIncarnation: 'process-1',
        launchTokenHash: createHash('sha256').update(evidence.launchToken).digest('hex')
      }
    })
  const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return {
    db,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    runtime,
    adoptedRunId,
    taskId: task.id,
    dispatchId: dispatch.id,
    notify,
    verify
  }
}

export function evidence(
  role: 'worker' | 'coordinator',
  valid = true
): OrchestrationCompatibilityEvidence {
  const worker = role === 'worker'
  return {
    terminalHandle: worker ? WORKER_HANDLE : COORDINATOR_HANDLE,
    paneKey: valid ? (worker ? WORKER_PANE : COORDINATOR_PANE) : 'tab_wrong:wrong-leaf',
    launchToken: `${role}-token`
  }
}

export function currentEvidence(
  role: 'worker' | 'coordinator'
): OrchestrationCompatibilityEvidence {
  const worker = role === 'worker'
  return {
    terminalHandle: worker ? CURRENT_WORKER_HANDLE : CURRENT_COORDINATOR_HANDLE,
    paneKey: worker ? CURRENT_WORKER_PANE : CURRENT_COORDINATOR_PANE,
    launchToken: `current-${role}-token`
  }
}

export function request(
  method: string,
  params: unknown,
  proof: OrchestrationCompatibilityEvidence,
  invocationId: string
): RpcRequest {
  return {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    compatibilityInvocationId: invocationId,
    orchestrationCompatibilityEvidence: proof
  }
}

export async function invoke(
  dispatcher: RpcDispatcher,
  rpcRequest: RpcRequest,
  transport: Transport
): Promise<RpcResponse> {
  if (transport === 'dispatch') {
    return await dispatcher.dispatch(rpcRequest)
  }
  const replies: string[] = []
  await dispatcher.dispatchStreaming(rpcRequest, (reply) => replies.push(reply))
  expect(replies).toHaveLength(1)
  return JSON.parse(replies[0]) as RpcResponse
}

export function counts(db: OrchestrationDb): Record<string, number> {
  const sqlite = (db as unknown as { db: Database.Database }).db
  return Object.fromEntries(
    [
      'messages',
      'legacy_compatibility_principals',
      'legacy_operation_receipts',
      'legacy_mail_receipts',
      'mutation_receipts'
    ].map((table) => [
      table,
      (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    ])
  )
}

export function escalationParams(harness: LegacyCompatibilityDispatcherHarness) {
  return {
    from: WORKER_HANDLE,
    to: COORDINATOR_HANDLE,
    subject: 'Blocked',
    type: 'escalation',
    payload: JSON.stringify({ taskId: harness.taskId, dispatchId: harness.dispatchId })
  }
}
