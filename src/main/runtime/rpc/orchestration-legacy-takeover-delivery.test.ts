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

const WORKER_HANDLE = 'term_legacy_worker'
const WORKER_PANE = 'tab_worker:33333333-3333-4333-8333-333333333333'
const COORDINATOR_HANDLE = 'term_legacy_coord'
const COORDINATOR_PANE = 'tab_coord:44444444-4444-4444-8444-444444444444'
const CURRENT_COORDINATOR_HANDLE = 'term_current_coord'
const CURRENT_COORDINATOR_PANE = 'tab_current:55555555-5555-4555-8555-555555555555'
// The replacement coordinator after a retain/restart: same handle, new pane identity.
const RESTARTED_COORDINATOR_PANE = 'tab_current:99999999-9999-4999-8999-999999999999'
// A coordinator terminal that restarted inside the legacy coordinator's own pane.
const REBOUND_COORDINATOR_HANDLE = 'term_rebound_coord'

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
  for (const database of databases.splice(0)) {
    database.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'orca-legacy-takeover-delivery-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'orchestration.db')
  const before = new OrchestrationDb(dbPath)
  const task = before.createTask({
    spec: 'legacy assignment',
    createdByTerminalHandle: COORDINATOR_HANDLE
  })
  const dispatch = before.createDispatchContext(task.id, WORKER_HANDLE, WORKER_PANE)
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
          : handle === REBOUND_COORDINATOR_HANDLE
            ? COORDINATOR_PANE
            : null
  )
  vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((proof) => {
    const valid =
      (proof?.terminalHandle === WORKER_HANDLE && proof.paneKey === WORKER_PANE) ||
      (proof?.terminalHandle === COORDINATOR_HANDLE && proof.paneKey === COORDINATOR_PANE) ||
      (proof?.terminalHandle === CURRENT_COORDINATOR_HANDLE &&
        proof.paneKey === CURRENT_COORDINATOR_PANE)
    if (!valid || !proof?.launchToken) {
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
    runtime,
    adoptedRunId,
    taskId: task.id,
    dispatchId: dispatch.id
  }
}

function evidence(
  role: 'worker' | 'coordinator' | 'current-coordinator'
): OrchestrationCompatibilityEvidence {
  const map = {
    worker: { handle: WORKER_HANDLE, pane: WORKER_PANE },
    coordinator: { handle: COORDINATOR_HANDLE, pane: COORDINATOR_PANE },
    'current-coordinator': { handle: CURRENT_COORDINATOR_HANDLE, pane: CURRENT_COORDINATOR_PANE }
  }
  const entry = map[role]
  return {
    terminalHandle: entry.handle,
    paneKey: entry.pane,
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

function commitLegacyCoordinatorPrincipal(harness: Harness): { id: string } {
  const { principal } = harness.db.commitLegacyCompatibilityPrincipal({
    runId: harness.adoptedRunId,
    role: 'coordinator',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    terminalHandle: COORDINATOR_HANDLE,
    paneKey: COORDINATOR_PANE,
    launchTokenHash: 'coord-hash',
    processIncarnation: 'process-1'
  })
  expect(principal.status).toBe('committed')
  return principal
}

// Why: assert the takeover landed here, so a broken bind fails at cause instead of two tests later.
function takeOverWithCommittedPrincipal(harness: Harness): void {
  commitLegacyCoordinatorPrincipal(harness)
  const bound = harness.db.bindRun({
    runId: harness.adoptedRunId,
    coordinatorHandle: CURRENT_COORDINATOR_HANDLE,
    coordinatorPaneKey: CURRENT_COORDINATOR_PANE,
    takeoverLegacy: true
  })
  expect(bound).toMatchObject({
    id: harness.adoptedRunId,
    coordinator_handle: CURRENT_COORDINATOR_HANDLE,
    coordinator_pane_key: CURRENT_COORDINATOR_PANE
  })
  expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('revoked')
}

describe('legacy coordinator delivery targets after takeover', () => {
  it('accepts both the old and new coordinator handles after principal revocation', () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    // Old handle still routable (retained).
    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, COORDINATOR_HANDLE)
    ).toBe(true)
    // New handle also routable (current binding).
    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, CURRENT_COORDINATOR_HANDLE)
    ).toBe(true)
    // Unknown handle not routable.
    expect(harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, 'term_unknown')).toBe(
      false
    )
  })

  it('keeps the caller-side fence out of the replacement coordinator jurisdiction', async () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    // The replacement coordinator is a delivery target, but must never become fence jurisdiction:
    // fencing it would strand the Run's own owner behind unusable takeover guidance.
    expect(
      harness.db.isLegacyCoordinatorHandle(harness.adoptedRunId, CURRENT_COORDINATOR_HANDLE)
    ).toBe(false)

    // The pane identity changed under it, so this coordinator can no longer attest.
    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.taskList',
        { callerTerminalHandle: CURRENT_COORDINATOR_HANDLE },
        { ...evidence('current-coordinator'), paneKey: RESTARTED_COORDINATOR_PANE },
        'replacement-coordinator-not-fenced'
      )
    )

    // It still owns the Run binding, so it reads its own Run rather than being fenced read-only.
    expect(response).toMatchObject({
      ok: true,
      result: { runId: harness.adoptedRunId, legacyReadOnly: false }
    })
  })

  it('lets a worker send worker_done to the new coordinator after principal revocation', async () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: WORKER_HANDLE,
          to: CURRENT_COORDINATOR_HANDLE,
          subject: 'Completed',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: harness.taskId,
            dispatchId: harness.dispatchId,
            outcome: 'succeeded'
          })
        },
        evidence('worker'),
        'worker-done-to-new-coordinator'
      )
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        message: {
          to_handle: `run:${harness.adoptedRunId}`,
          delivery_contract: 'current_delivery',
          type: 'worker_done'
        }
      }
    })
  })

  it('lets a worker ask the new coordinator and get an answer after principal revocation', async () => {
    const harness = createHarness()
    takeOverWithCommittedPrincipal(harness)

    const asked = (await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        { from: WORKER_HANDLE, to: CURRENT_COORDINATOR_HANDLE, question: 'Ship it?', timeoutMs: 0 },
        evidence('worker'),
        'ask-new-coordinator'
      )
    )) as { ok: boolean; result: { messageId: string } }

    expect(asked).toMatchObject({ ok: true, result: { timedOut: true } })
    // The ask must reach the Run mailbox as a current-contract question, or nobody can answer it.
    expect(harness.db.getMessageById(asked.result.messageId)).toMatchObject({
      to_handle: `run:${harness.adoptedRunId}`,
      delivery_contract: 'current_delivery',
      type: 'question'
    })

    const replied = await harness.dispatcher.dispatch(
      request(
        'orchestration.reply',
        { id: asked.result.messageId, from: CURRENT_COORDINATOR_HANDLE, body: 'Yes, ship it.' },
        evidence('current-coordinator'),
        'reply-from-new-coordinator'
      )
    )
    expect(replied).toMatchObject({ ok: true })

    const resumed = await harness.dispatcher.dispatch(
      request(
        'orchestration.ask',
        { from: WORKER_HANDLE, resume: asked.result.messageId, timeoutMs: 0 },
        evidence('worker'),
        'ask-resume-after-reply'
      )
    )
    expect(resumed).toMatchObject({ ok: true, result: { answer: 'Yes, ship it.' } })
  })
})

// Why: bindRun only revokes a committed principal when it takes over or the legacy work is settled,
// so a coordinator restarting inside the legacy pane rebinds the Run while the principal stays
// committed. Delivery still routes legacy_direct to the addressed handle there, and no reader can
// see that mailbox, so the permit must refuse rather than accept mail nobody will ever read.
describe('legacy coordinator delivery targets without a takeover', () => {
  function rebindLegacyPaneWithoutTakeover(harness: Harness): { principalId: string } {
    const principal = commitLegacyCoordinatorPrincipal(harness)
    const run = harness.db.getRun(harness.adoptedRunId) as { consumer_generation: number }
    expect(
      harness.db.bindRun({
        runId: harness.adoptedRunId,
        coordinatorHandle: COORDINATOR_HANDLE,
        coordinatorPaneKey: COORDINATOR_PANE,
        legacyCoordinatorAuthority: {
          runId: harness.adoptedRunId,
          principalId: principal.id,
          terminalHandle: COORDINATOR_HANDLE,
          paneKey: COORDINATOR_PANE,
          consumerGeneration: run.consumer_generation
        }
      })
    ).toMatchObject({ coordinator_handle: COORDINATOR_HANDLE })

    expect(
      harness.db.bindRun({
        runId: harness.adoptedRunId,
        coordinatorHandle: REBOUND_COORDINATOR_HANDLE,
        coordinatorPaneKey: COORDINATOR_PANE
      })
    ).toMatchObject({ coordinator_handle: REBOUND_COORDINATOR_HANDLE })
    expect(harness.db.getLegacyCoordinatorPrincipal(harness.adoptedRunId)?.status).toBe('committed')
    return { principalId: principal.id }
  }

  it('refuses the rebound coordinator handle while the legacy principal is still committed', () => {
    const harness = createHarness()
    rebindLegacyPaneWithoutTakeover(harness)

    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, REBOUND_COORDINATOR_HANDLE)
    ).toBe(false)
    // The still-committed principal's own handle stays reachable.
    expect(
      harness.db.isLegacyCoordinatorDeliveryTarget(harness.adoptedRunId, COORDINATOR_HANDLE)
    ).toBe(true)
  })

  it('rejects worker_done to the rebound handle instead of writing unreadable mail', async () => {
    const harness = createHarness()
    const { principalId } = rebindLegacyPaneWithoutTakeover(harness)

    const response = await harness.dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          from: WORKER_HANDLE,
          to: REBOUND_COORDINATOR_HANDLE,
          subject: 'Completed',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: harness.taskId,
            dispatchId: harness.dispatchId,
            outcome: 'succeeded'
          })
        },
        evidence('worker'),
        'worker-done-to-rebound-coordinator'
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    // Nothing was written to a mailbox that neither contract can read.
    expect(harness.db.getUnreadMessages(REBOUND_COORDINATOR_HANDLE)).toHaveLength(0)
    expect(harness.db.getLegacyMailHistory({ principalId }).messages).toHaveLength(0)
  })
})
