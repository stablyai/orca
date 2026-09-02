import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

const COORDINATOR_HANDLE = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'

type Transport = 'dispatch' | 'websocket'

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

async function invoke(
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

function installTakeoverDuringMutationPreflight(harness: Harness): void {
  const originalBegin = harness.db.beginMutationReceipt.bind(harness.db)
  vi.spyOn(harness.db, 'beginMutationReceipt').mockImplementation((identity) => {
    const begun = originalBegin(identity)
    settleLegacyWorkerAndTakeOver(harness, 'settled during takeover')
    return begun
  })
}

function settleLegacyWorkerAndTakeOver(harness: Harness, result: string): void {
  harness.db.settleWorkerReport({
    taskId: harness.taskId,
    dispatchId: harness.dispatchId,
    outcome: 'succeeded',
    result
  })
  harness.db.bindRun({
    runId: harness.adoptedRunId,
    coordinatorHandle: 'term_current_coord',
    coordinatorPaneKey: 'tab_current:55555555-5555-4555-8555-555555555555'
  })
}

function mutationReceiptCount(db: OrchestrationDb): number {
  const sqlite = (db as unknown as { db: Database.Database }).db
  return (
    sqlite.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }
  ).count
}

function messageCount(db: OrchestrationDb): number {
  const sqlite = (db as unknown as { db: Database.Database }).db
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count
}

describe('legacy coordinator takeover races', () => {
  it.each(['dispatch', 'websocket'] as const)(
    '%s routes a pre-bind coordinator send to the retained worker mailbox',
    async (transport) => {
      const harness = createHarness()

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.send',
          { from: COORDINATOR_HANDLE, to: WORKER_HANDLE, subject: 'continue safely' },
          `send-direct-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          message: {
            run_id: harness.adoptedRunId,
            to_handle: `dispatch:${harness.dispatchId}`,
            delivery_contract: 'legacy_direct'
          }
        }
      })
      const workerCheck = await harness.dispatcher.dispatch(
        request(
          'orchestration.check',
          { terminal: WORKER_HANDLE },
          `worker-check-${transport}`,
          evidence('worker')
        )
      )
      expect(workerCheck).toMatchObject({
        ok: true,
        result: {
          messages: [
            {
              subject: 'continue safely',
              run_id: harness.adoptedRunId,
              delivery_contract: 'legacy_direct'
            }
          ],
          legacyCompatibility: { ackMessageIds: [expect.any(String)] }
        }
      })
      expect(
        harness.db.getInbox(100).some((message) => message.run_id === 'run_legacy_local')
      ).toBe(false)
    }
  )

  it('replays coordinator mutations after transport authentication rotates', async () => {
    const harness = createHarness()
    const mutation = request(
      'orchestration.send',
      { from: COORDINATOR_HANDLE, to: WORKER_HANDLE, subject: 'send once' },
      'coordinator-restart-send'
    )
    mutation.authToken = 'before-restart'

    const first = await harness.dispatcher.dispatch(mutation)
    const restartedDispatcher = new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    })
    const replay = await restartedDispatcher.dispatch({
      ...mutation,
      id: 'rpc_coordinator-restart-send-retry',
      authToken: 'after-restart'
    })

    expect(first).toMatchObject({
      ok: true,
      result: {
        message: { subject: 'send once' },
        mutation: { requestId: 'coordinator-restart-send', replayed: false }
      }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: {
        message: { id: (first as { result: { message: { id: string } } }).result.message.id },
        mutation: { requestId: 'coordinator-restart-send', replayed: true }
      }
    })
    expect(messageCount(harness.db)).toBe(1)
    expect(mutationReceiptCount(harness.db)).toBe(1)
  })

  it('routes an exact legacy Dispatch recipient to compatibility delivery', async () => {
    const harness = createHarness()

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: COORDINATOR_HANDLE,
          to: `dispatch:${harness.dispatchId}`,
          subject: 'dispatch guidance'
        },
        'send-dispatch'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: {
          run_id: harness.adoptedRunId,
          to_handle: `dispatch:${harness.dispatchId}`,
          delivery_contract: 'legacy_direct'
        }
      }
    })
    const workerCheck = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: WORKER_HANDLE },
        'worker-check-dispatch',
        evidence('worker')
      )
    )
    expect(workerCheck).toMatchObject({
      ok: true,
      result: { messages: [{ subject: 'dispatch guidance' }] }
    })
  })

  it('partitions a coordinator group send by legacy recipient contract', async () => {
    const harness = createHarness()
    vi.mocked(harness.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === COORDINATOR_HANDLE
        ? COORDINATOR_PANE
        : handle === WORKER_HANDLE
          ? WORKER_PANE
          : handle === 'term_current_worker'
            ? 'tab_current_worker:leaf_current_worker'
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
          to_handle: 'term_current_worker',
          delivery_contract: 'current_delivery'
        })
      ])
    )
  })

  it.each(['dispatch', 'websocket'] as const)(
    '%s rejects a coordinator send after takeover during durable preflight',
    async (transport) => {
      const harness = createHarness()
      installTakeoverDuringMutationPreflight(harness)
      const before = messageCount(harness.db)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.send',
          { from: COORDINATOR_HANDLE, to: WORKER_HANDLE, subject: 'must not send' },
          `send-takeover-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
      expect(messageCount(harness.db)).toBe(before)
      expect(mutationReceiptCount(harness.db)).toBe(0)
    }
  )

  it('revalidates a group send after asynchronous terminal discovery', async () => {
    const harness = createHarness()
    let resolveTerminals:
      | ((value: {
          terminals: { handle: string }[]
          totalCount: number
          truncated: boolean
        }) => void)
      | undefined
    let signalListingStarted: (() => void) | undefined
    const listingStarted = new Promise<void>((resolve) => {
      signalListingStarted = resolve
    })
    vi.spyOn(harness.runtime, 'listTerminals').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTerminals = resolve as typeof resolveTerminals
          signalListingStarted?.()
        }) as never
    )
    const before = messageCount(harness.db)
    const pending = harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        { from: COORDINATOR_HANDLE, to: '@all', subject: 'must remain unsent' },
        'send-group-takeover'
      )
    )
    await listingStarted
    settleLegacyWorkerAndTakeOver(harness, 'settled during terminal discovery')
    resolveTerminals?.({
      terminals: [{ handle: COORDINATOR_HANDLE }, { handle: WORKER_HANDLE }],
      totalCount: 2,
      truncated: false
    })

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'legacy_read_only' }
    })
    expect(messageCount(harness.db)).toBe(before)
    expect(mutationReceiptCount(harness.db)).toBe(0)
  })

  it('reports a committed ACK when coordinator takeover interrupts its wait', async () => {
    const harness = createHarness()
    const incoming = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: WORKER_HANDLE,
      to: `run:${harness.adoptedRunId}`,
      subject: 'ready to acknowledge'
    })
    const first = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: COORDINATOR_HANDLE, run: harness.adoptedRunId },
        'check-delivery-before-takeover'
      )
    )
    expect(first).toMatchObject({
      ok: true,
      result: { deliveryId: expect.any(String), messages: [{ id: incoming.id }] }
    })
    const deliveryId = (first as { result: { deliveryId: string } }).result.deliveryId
    let resolveWait: (() => void) | undefined
    let signalWaitStarted: (() => void) | undefined
    const waitStarted = new Promise<void>((resolve) => {
      signalWaitStarted = resolve
    })
    vi.spyOn(harness.runtime, 'waitForMessage').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWait = () => resolve('notified')
          signalWaitStarted?.()
        })
    )
    const pending = harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        {
          terminal: COORDINATOR_HANDLE,
          run: harness.adoptedRunId,
          ack: deliveryId,
          wait: true,
          timeoutMs: 10_000
        },
        'check-ack-takeover'
      )
    )
    await waitStarted
    expect(harness.db.getMessageById(incoming.id)?.read).toBe(1)
    settleLegacyWorkerAndTakeOver(harness, 'settled during acknowledged wait')
    resolveWait?.()

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: {
        acknowledged: deliveryId,
        count: 0,
        waitInterrupted: 'consumer_fenced',
        mutation: { requestId: 'check-ack-takeover', replayed: false }
      }
    })
    const sqlite = (harness.db as unknown as { db: Database.Database }).db
    expect(sqlite.prepare('SELECT state FROM mutation_receipts').get()).toEqual({
      state: 'completed'
    })
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
          resolveWait = () => resolve('notified')
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

  it.each(['dispatch', 'websocket'] as const)(
    '%s rejects run-use after takeover during durable preflight',
    async (transport) => {
      const harness = createHarness()
      installTakeoverDuringMutationPreflight(harness)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.runUse',
          { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
          `run-use-takeover-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
      expect(harness.db.getRun(harness.adoptedRunId)).toMatchObject({
        coordinator_handle: 'term_current_coord',
        consumer_generation: 1
      })
      expect(mutationReceiptCount(harness.db)).toBe(0)
      expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')
    }
  )

  it.each(['dispatch', 'websocket'] as const)(
    '%s rejects a mutation after takeover during durable preflight',
    async (transport) => {
      const harness = createHarness()
      const target = harness.db.createTask({
        spec: 'must remain ready',
        runId: harness.adoptedRunId
      })
      installTakeoverDuringMutationPreflight(harness)

      const response = await invoke(
        harness.dispatcher,
        request(
          'orchestration.taskUpdate',
          {
            id: target.id,
            status: 'completed',
            callerTerminalHandle: COORDINATOR_HANDLE
          },
          `task-update-takeover-${transport}`
        ),
        transport
      )

      expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
      expect(harness.db.getTask(target.id)?.status).toBe('ready')
      expect(mutationReceiptCount(harness.db)).toBe(0)
    }
  )

  it('revalidates after asynchronous agent detection', async () => {
    const harness = createHarness()
    const target = harness.db.createTask({
      spec: 'must not dispatch after takeover',
      runId: harness.adoptedRunId
    })
    const targetHandle = 'term_current_worker'
    const targetPane = 'tab_current_worker:77777777-7777-4777-8777-777777777777'
    vi.spyOn(harness.runtime, 'getTerminalPaneKey').mockImplementation((handle: string) =>
      handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : handle === targetHandle ? targetPane : null
    )
    vi.spyOn(harness.runtime, 'getTerminalProcessIncarnation').mockReturnValue('current-process')
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === targetHandle
        ? ({
            terminalHandle: targetHandle,
            paneKey: targetPane,
            processIncarnation: 'current-process',
            launchTokenHash: null
          } as never)
        : null
    )
    let resolveDetection: ((detected: boolean) => void) | undefined
    let signalDetectionStarted: (() => void) | undefined
    const detectionStarted = new Promise<void>((resolve) => {
      signalDetectionStarted = resolve
    })
    let detectionCalls = 0
    vi.spyOn(harness.runtime, 'isTerminalRunningAgent').mockImplementation(
      () =>
        new Promise<boolean>((resolve, reject) => {
          detectionCalls += 1
          // Why reject instead of re-arming: a second call would overwrite resolveDetection and
          // strand the first promise, hanging to a timeout instead of naming what changed.
          if (detectionCalls > 1) {
            reject(
              new Error(
                `isTerminalRunningAgent was called ${detectionCalls} times; this test drives exactly one detection.`
              )
            )
            return
          }
          resolveDetection = resolve
          signalDetectionStarted?.()
        })
    )
    const sendPrompt = vi
      .spyOn(harness.runtime, 'sendTerminalAgentPrompt')
      .mockResolvedValue({ handle: targetHandle, accepted: true, bytesWritten: 1 })

    const pending = harness.dispatcher.dispatch(
      request(
        'orchestration.dispatch',
        { task: target.id, to: targetHandle, from: COORDINATOR_HANDLE, inject: true },
        'dispatch-detection-takeover'
      )
    )
    await detectionStarted
    settleLegacyWorkerAndTakeOver(harness, 'settled during detection')
    resolveDetection?.(true)
    const response = await pending

    expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
    expect(harness.db.getTask(target.id)?.status).toBe('ready')
    expect(harness.db.getDispatchContext(target.id)).toBeUndefined()
    expect(sendPrompt).not.toHaveBeenCalled()
  })
})
