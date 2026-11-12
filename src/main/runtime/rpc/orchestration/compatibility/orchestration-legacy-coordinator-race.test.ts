import { createHash } from 'node:crypto'

import { mkdtempSync, rmSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'

import type { OrchestrationCompatibilityEvidence } from '../../../../../shared/orchestration/orchestration-compatibility-evidence'

import Database from '../../../../sqlite/sync-database'

import { OrcaRuntimeService } from '../../../orca-runtime'

import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'

import '../../../orchestration/db/contract-constants'
import '../../../orchestration/db/messages/mailbox-routing-page'
import '../../../orchestration/db/dispatch-row-writer'
import '../../../orchestration/db/attempt-outcome-projection'
import type { RpcRequest } from '../../core'

import { RpcDispatcher } from '../../dispatcher'

import { ORCHESTRATION_METHODS } from '../../methods/orchestration/orchestration'

import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

import { MessageWake } from '../../../orchestration/mailbox/runtime-message-waiters'

const COORDINATOR_HANDLE = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'

type Harness = {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  runtime: OrcaRuntimeService
  adoptedRunId: string
  taskId: string
  dispatchId: string
}

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  databases.splice(0).forEach((database) => database.close())
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-coordinator-race-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    runId: 'run_legacy_local',
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
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : handle === WORKER_HANDLE ? WORKER_PANE : null
  )
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
    runtime.getTerminalPaneKey(handle)
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
    (compatibilityEvidence) => {
      const coordinator =
        compatibilityEvidence?.terminalHandle === COORDINATOR_HANDLE &&
        compatibilityEvidence.paneKey === COORDINATOR_PANE &&
        compatibilityEvidence.launchToken === 'coordinator-token'
      const worker =
        compatibilityEvidence?.terminalHandle === WORKER_HANDLE &&
        compatibilityEvidence.paneKey === WORKER_PANE &&
        compatibilityEvidence.launchToken === 'worker-token'
      return coordinator || worker
        ? {
            hostScope: { kind: 'local', hostId: 'local' },
            terminalHandle: coordinator ? COORDINATOR_HANDLE : WORKER_HANDLE,
            paneKey: coordinator ? COORDINATOR_PANE : WORKER_PANE,
            processIncarnation: 'process-1',
            launchTokenHash: createHash('sha256')
              .update(coordinator ? 'coordinator-token' : 'worker-token')
              .digest('hex')
          }
        : null
    }
  )
  return {
    db,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    runtime,
    adoptedRunId,
    taskId: task.id,
    dispatchId: dispatch.id
  }
}

function evidence(
  role: 'coordinator' | 'worker' = 'coordinator'
): OrchestrationCompatibilityEvidence {
  return {
    terminalHandle: role === 'coordinator' ? COORDINATOR_HANDLE : WORKER_HANDLE,
    paneKey: role === 'coordinator' ? COORDINATOR_PANE : WORKER_PANE,
    launchToken: role === 'coordinator' ? 'coordinator-token' : 'worker-token'
  }
}

function request(
  method: string,
  params: unknown,
  invocationId: string,
  callerEvidence = evidence()
): RpcRequest {
  return {
    id: `rpc_${invocationId}`,
    authToken: 'caller-token',
    method,
    params,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: invocationId,
    compatibilityInvocationId: invocationId,
    orchestrationCompatibilityEvidence: callerEvidence
  }
}

describe('legacy coordinator takeover races', () => {
  it('partitions a coordinator group send by legacy recipient contract', async () => {
    const harness = createHarness()
    // Use two current-contract Dispatches in the adopted Run: group mail targets Dispatches, so a loose pane cannot prove partitioning.
    const currentTask = harness.db.createTask({
      runId: harness.adoptedRunId,
      spec: 'current-contract assignment',
      createdByTerminalHandle: COORDINATOR_HANDLE
    })
    const currentDispatch = createRootDispatch(
      harness.db,
      currentTask.id,
      'term_current_worker',
      'tab_current_worker:22222222-2222-4222-8222-222222222222'
    )
    vi.mocked(harness.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === COORDINATOR_HANDLE
        ? COORDINATOR_PANE
        : handle === WORKER_HANDLE
          ? WORKER_PANE
          : handle === 'term_current_worker'
            ? 'tab_current_worker:22222222-2222-4222-8222-222222222222'
            : null
    )
    vi.spyOn(harness.runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        { handle: COORDINATOR_HANDLE },
        { handle: WORKER_HANDLE },
        { handle: 'term_current_worker' }
      ],
      totalCount: 3,
      truncated: false
    } as never)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        { from: COORDINATOR_HANDLE, to: '@all', subject: 'group guidance' },
        'send-group'
      )
    )

    expect(response).toMatchObject({ ok: true, result: { recipients: 2 } })
    const messages = harness.db
      .getInbox(100)
      .filter((message) => message.subject === 'group guidance')
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: harness.adoptedRunId,
          to_handle: `dispatch:${harness.dispatchId}`,
          delivery_contract: 'legacy_direct'
        }),
        expect.objectContaining({
          run_id: harness.adoptedRunId,
          to_handle: `dispatch:${currentDispatch.id}`,
          delivery_contract: 'current_delivery'
        })
      ])
    )
  })

  it('keeps concurrent duplicates on the live ACK-and-wait result', async () => {
    const harness = createHarness()
    harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: WORKER_HANDLE,
      to: `run:${harness.adoptedRunId}`,
      subject: 'first delivery'
    })
    const firstCheck = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: COORDINATOR_HANDLE, run: harness.adoptedRunId },
        'check-first-delivery'
      )
    )
    const deliveryId = (firstCheck as { result: { deliveryId: string } }).result.deliveryId
    let resolveWait: (() => void) | undefined
    let signalWaitStarted: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => {
      signalWaitStarted = resolve
    })
    vi.spyOn(harness.runtime, 'waitForMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWait = () => resolve(new MessageWake())
          signalWaitStarted?.()
        })
    )
    const ackRequest = request(
      'orchestration.check',
      {
        terminal: COORDINATOR_HANDLE,
        run: harness.adoptedRunId,
        ack: deliveryId,
        wait: true,
        timeoutMs: 10_000
      },
      'check-ack-concurrent'
    )
    const original = harness.dispatcher.dispatch(ackRequest)
    await waitStarted
    const secondLiveDispatcher = new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    })
    const duplicate = secondLiveDispatcher.dispatch({
      ...ackRequest,
      id: 'rpc_check-ack-concurrent-duplicate'
    })
    let duplicateSettled = false
    void duplicate.then(() => {
      duplicateSettled = true
    })
    await Promise.resolve()
    expect(duplicateSettled).toBe(false)

    const arrived = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: WORKER_HANDLE,
      to: `run:${harness.adoptedRunId}`,
      subject: 'arrived while waiting'
    })
    resolveWait?.()
    const [originalResult, duplicateResult] = await Promise.all([original, duplicate])
    expect(originalResult).toMatchObject({
      ok: true,
      result: {
        messages: [{ id: arrived.id }],
        mutation: { requestId: 'check-ack-concurrent', replayed: false }
      }
    })
    expect(duplicateResult).toMatchObject({
      ok: true,
      result: {
        messages: [{ id: arrived.id }],
        mutation: { requestId: 'check-ack-concurrent', replayed: true }
      }
    })
  })
})
