import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import Database from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
const COORDINATOR_HANDLE = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
const CURRENT_COORDINATOR_PANE = 'tab_current:55555555-5555-4555-8555-555555555555'

type Harness = {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  adoptedRunId: string
  taskId: string
  dispatchId: string
}

const tempDirs: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-takeover-'))
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
    handle === COORDINATOR_HANDLE
      ? COORDINATOR_PANE
      : handle === WORKER_HANDLE
        ? WORKER_PANE
        : handle === CURRENT_COORDINATOR_HANDLE
          ? CURRENT_COORDINATOR_PANE
          : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((proof) => {
    const validWorker = proof?.terminalHandle === WORKER_HANDLE && proof.paneKey === WORKER_PANE
    const validCoordinator =
      proof?.terminalHandle === COORDINATOR_HANDLE && proof.paneKey === COORDINATOR_PANE
    const validCurrentCoordinator =
      proof?.terminalHandle === CURRENT_COORDINATOR_HANDLE &&
      proof.paneKey === CURRENT_COORDINATOR_PANE
    if ((!validWorker && !validCoordinator && !validCurrentCoordinator) || !proof?.launchToken) {
      return null
    }
    return {
      hostScope: { kind: 'local', hostId: 'local' },
      terminalHandle: proof.terminalHandle as string,
      paneKey: proof.paneKey as string,
      processIncarnation: 'process-1',
      launchTokenHash: createHash('sha256').update(proof.launchToken).digest('hex')
    }
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  return {
    db,
    dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
    adoptedRunId,
    taskId: task.id,
    dispatchId: dispatch.id
  }
}

function evidence(
  role: 'worker' | 'coordinator' | 'current-coordinator'
): OrchestrationCompatibilityEvidence {
  const worker = role === 'worker'
  const currentCoordinator = role === 'current-coordinator'
  return {
    terminalHandle: worker
      ? WORKER_HANDLE
      : currentCoordinator
        ? CURRENT_COORDINATOR_HANDLE
        : COORDINATOR_HANDLE,
    paneKey: worker
      ? WORKER_PANE
      : currentCoordinator
        ? CURRENT_COORDINATOR_PANE
        : COORDINATOR_PANE,
    launchToken: `${role}-token`
  }
}

function request(
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

function counts(db: OrchestrationDb): Record<string, number> {
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

function escalationParams(harness: Harness) {
  return {
    from: WORKER_HANDLE,
    to: COORDINATOR_HANDLE,
    subject: 'Blocked',
    type: 'escalation',
    payload: JSON.stringify({ taskId: harness.taskId, dispatchId: harness.dispatchId })
  }
}

describe('legacy compatibility after explicit takeover', () => {
  it('binds takeover to the authenticated invoking coordinator pane', async () => {
    const harness = createHarness()
    const before = harness.db.getRun(harness.adoptedRunId)

    const spoofed = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        {
          id: harness.adoptedRunId,
          from: COORDINATOR_HANDLE,
          takeoverLegacy: true
        },
        evidence('current-coordinator'),
        'spoofed-takeover'
      )
    )

    expect(spoofed).toMatchObject({
      ok: false,
      error: { code: 'legacy_read_only', data: { effectsApplied: false } }
    })
    expect(harness.db.getRun(harness.adoptedRunId)).toEqual(before)

    const bound = await harness.dispatcher.dispatch(
      request(
        'orchestration.runUse',
        {
          id: harness.adoptedRunId,
          from: CURRENT_COORDINATOR_HANDLE,
          takeoverLegacy: true
        },
        evidence('current-coordinator'),
        'authenticated-takeover'
      )
    )

    expect(bound).toMatchObject({
      ok: true,
      result: {
        run: {
          coordinator_handle: CURRENT_COORDINATOR_HANDLE,
          coordinator_pane_key: CURRENT_COORDINATOR_PANE
        }
      }
    })
  })

  it('does not let an uncommitted legacy coordinator attest after explicit takeover', async () => {
    const harness = createHarness()
    harness.db.bindRun({
      runId: harness.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:55555555-5555-4555-8555-555555555555',
      takeoverLegacy: true
    })
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)).toBeUndefined()
    const before = counts(harness.db)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        {},
        evidence('coordinator'),
        'uncommitted-coordinator-after-takeover'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)).toBeUndefined()
    expect(counts(harness.db)).toEqual(before)
  })

  it.each(['escalation', 'worker_done'] as const)(
    'keeps the retained coordinator address routable for post-takeover %s',
    async (type) => {
      const harness = createHarness()
      harness.db.bindRun({
        runId: harness.adoptedRunId,
        coordinatorHandle: 'term_current_coord',
        coordinatorPaneKey: 'tab_current:55555555-5555-4555-8555-555555555555',
        takeoverLegacy: true
      })

      const response = await harness.dispatcher.dispatch(
        request(
          'orchestration.send',
          {
            ...escalationParams(harness),
            type,
            subject: type === 'worker_done' ? 'Completed' : 'Blocked'
          },
          evidence('worker'),
          `post-takeover-${type}`
        )
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          message: {
            to_handle: `run:${harness.adoptedRunId}`,
            delivery_contract: 'current_delivery',
            type
          }
        }
      })
    }
  )

  it('routes future worker mail to Run Delivery after same-handle takeover', async () => {
    const harness = createHarness()
    harness.db.bindRun({
      runId: harness.adoptedRunId,
      coordinatorHandle: COORDINATOR_HANDLE,
      coordinatorPaneKey: COORDINATOR_PANE,
      takeoverLegacy: true
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        escalationParams(harness),
        evidence('worker'),
        'same-handle-takeover-mail'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: {
          to_handle: `run:${harness.adoptedRunId}`,
          delivery_contract: 'current_delivery',
          type: 'escalation'
        }
      }
    })
  })

  it('keeps post-takeover legacy ask routed to the adopted Run', async () => {
    const harness = createHarness()
    harness.db.bindRun({
      runId: harness.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:55555555-5555-4555-8555-555555555555',
      takeoverLegacy: true
    })

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          to: COORDINATOR_HANDLE,
          question: 'Continue after takeover?',
          timeoutMs: 1
        },
        evidence('worker'),
        'post-takeover-ask'
      )
    )
    const messageId = (response as { result?: { messageId?: string } }).result?.messageId

    expect(response).toMatchObject({
      ok: true,
      result: { timedOut: true, messageId: expect.any(String) }
    })
    expect(harness.db.getMessageById(messageId as string)).toMatchObject({
      to_handle: `run:${harness.adoptedRunId}`,
      delivery_contract: 'current_delivery',
      type: 'question'
    })
  })

  it('keeps an active legacy worker usable across authenticated takeover', async () => {
    const harness = createHarness()
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.runUse',
          { id: harness.adoptedRunId, from: COORDINATOR_HANDLE },
          evidence('coordinator'),
          'bind-original-coordinator'
        )
      )
    ).resolves.toMatchObject({ ok: true })
    const pendingAsk = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        {
          from: WORKER_HANDLE,
          to: COORDINATOR_HANDLE,
          question: 'Continue with the migration?',
          timeoutMs: 0
        },
        evidence('worker'),
        'pending-before-takeover'
      )
    )
    const questionId = (pendingAsk as { result: { messageId: string } }).result.messageId
    const unrelated = harness.db.insertMessage({
      runId: harness.adoptedRunId,
      from: WORKER_HANDLE,
      to: 'term_peer_worker',
      subject: 'peer-only',
      deliveryContract: 'legacy_direct'
    })
    const currentRequest = (method: string, params: unknown, invocationId: string) =>
      request(method, params, evidence('current-coordinator'), invocationId)
    const takeoverParams = {
      id: harness.adoptedRunId,
      from: CURRENT_COORDINATOR_HANDLE,
      takeoverLegacy: true
    }

    const takeover = await harness.dispatcher.dispatch(
      currentRequest('orchestration.runUse', takeoverParams, 'explicit-takeover')
    )
    const repeated = await harness.dispatcher.dispatch(
      currentRequest('orchestration.runUse', takeoverParams, 'explicit-takeover-repeat')
    )

    expect(takeover).toMatchObject({
      ok: true,
      result: { binding: { consumerGeneration: 2 } }
    })
    expect(repeated).toMatchObject({
      ok: true,
      result: { binding: { consumerGeneration: 2 } }
    })
    expect(harness.db.getDispatchContextById(harness.dispatchId)?.status).toBe('dispatched')
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')
    expect(harness.db.getMessageById(unrelated.id)).toMatchObject({
      to_handle: 'term_peer_worker',
      delivery_contract: 'legacy_direct'
    })

    const promoted = await harness.dispatcher.dispatch(
      currentRequest(
        'orchestration.check',
        {
          terminal: CURRENT_COORDINATOR_HANDLE,
          run: harness.adoptedRunId,
          format: true
        },
        'read-promoted-question'
      )
    )
    expect(promoted).toMatchObject({
      ok: true,
      result: {
        messages: [
          {
            id: questionId,
            to_handle: `run:${harness.adoptedRunId}`,
            delivery_contract: 'current_delivery'
          }
        ],
        formatted: expect.not.stringContaining(`--from run:${harness.adoptedRunId}`)
      }
    })
    const deliveryId = (promoted as { result: { deliveryId: string } }).result.deliveryId
    await expect(
      harness.dispatcher.dispatch(
        currentRequest(
          'orchestration.reply',
          {
            id: questionId,
            body: 'Yes, continue.',
            from: CURRENT_COORDINATOR_HANDLE,
            run: harness.adoptedRunId
          },
          'reply-after-takeover'
        )
      )
    ).resolves.toMatchObject({ ok: true, result: { question: { status: 'answered' } } })
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.ask',
          { from: WORKER_HANDLE, resume: questionId, timeoutMs: 100 },
          evidence('worker'),
          'resume-after-takeover'
        )
      )
    ).resolves.toMatchObject({ ok: true, result: { answer: 'Yes, continue.' } })

    const followUp = await harness.dispatcher.dispatch(
      currentRequest(
        'orchestration.send',
        {
          from: CURRENT_COORDINATOR_HANDLE,
          to: `dispatch:${harness.dispatchId}`,
          subject: 'Continue from the new coordinator'
        },
        'current-coordinator-to-legacy-worker'
      )
    )
    expect(followUp).toMatchObject({
      ok: true,
      result: {
        message: {
          run_id: harness.adoptedRunId,
          to_handle: `dispatch:${harness.dispatchId}`,
          delivery_contract: 'legacy_direct'
        }
      }
    })
    const workerFollowUp = await harness.dispatcher.dispatch(
      request(
        'orchestration.check',
        { terminal: WORKER_HANDLE },
        evidence('worker'),
        'legacy-worker-check-after-takeover'
      )
    )
    expect(workerFollowUp).toMatchObject({
      ok: true,
      result: {
        messages: [{ subject: 'Continue from the new coordinator' }],
        legacyCompatibility: { ackMessageIds: [expect.any(String)] }
      }
    })
    const [followUpMessageId] = (
      workerFollowUp as { result: { legacyCompatibility: { ackMessageIds: string[] } } }
    ).result.legacyCompatibility.ackMessageIds
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.check',
          {
            terminal: WORKER_HANDLE,
            compatibilityAck: JSON.stringify({ messageIds: [followUpMessageId] })
          },
          evidence('worker'),
          'legacy-worker-ack-after-takeover'
        )
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        acknowledged: [followUpMessageId],
        legacyCompatibility: { acknowledged: true }
      }
    })

    await harness.dispatcher.dispatch(
      currentRequest(
        'orchestration.check',
        {
          terminal: CURRENT_COORDINATOR_HANDLE,
          run: harness.adoptedRunId,
          ack: deliveryId
        },
        'ack-promoted-question'
      )
    )
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.send',
          {
            from: WORKER_HANDLE,
            to: COORDINATOR_HANDLE,
            subject: 'Need current coordinator',
            type: 'escalation',
            payload: JSON.stringify({ taskId: harness.taskId })
          },
          evidence('worker'),
          'escalation-after-takeover'
        )
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        message: {
          to_handle: `run:${harness.adoptedRunId}`,
          delivery_contract: 'current_delivery'
        }
      }
    })
    await expect(
      harness.dispatcher.dispatch(
        request(
          'orchestration.taskList',
          { callerTerminalHandle: COORDINATOR_HANDLE },
          evidence('coordinator'),
          'old-coordinator-fenced'
        )
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'legacy_read_only' } })
  })
})
