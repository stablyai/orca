import { agentSessionExecutionReceiptSchema } from '../../../../../shared/agent-session/agent-session-execution-receipt'
import { readWorkerExecutionReceipt } from '../../../rpc/methods/orchestration/worker/worker-execution-receipt'
import { createHash } from 'node:crypto'
import { agentSessionExecutionPolicyFingerprint } from '../../../../../shared/agent-session/agent-session-execution-policy'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createExecutionReportPublisher } from './agent-session-execution-report'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../terminal-authority/structured-sessions/structured-worker-identity'

vi.mock('../../../agent-session/records/agent-session-execution-runtime', () => ({
  executionBuildHash: 'd'.repeat(16)
}))

let rig: RestTestRig
let db: OrchestrationDb
let taskId: string
let parentTaskId: string
let dispatchId: string
let generation: string | null
let fence: number
const notify = vi.fn()
const runtime = { getOrchestrationDb: () => db, notifyMessageArrived: notify }

beforeEach(async () => {
  generation = 'execution-generation'
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
  db = new OrchestrationDb(':memory:')
  const policy = {
    schema: 1 as const,
    sourcePin: 'a'.repeat(40),
    deadlineAt: HOST_TEST_NOW + 120_000,
    accountFingerprint: `codex:${'b'.repeat(64)}`,
    model: 'model-one',
    effort: 'low',
    access: 'read-only' as const
  }

  const run = db.createRun({
    objective: 'Owner task',
    coordinatorHandle: 'term_owner',
    coordinatorPaneKey: 'tab_owner:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const parent = db.createTask({ runId: run.id, spec: 'Owner deliverable' })
  parentTaskId = parent.id
  createRootDispatch(db, parent.id, 'term_owner')
  taskId = db.createTask({ runId: run.id, parentId: parent.id, spec: 'One bounded question' }).id
  dispatchId = db.createStartingWorkerDispatch({
    taskId,
    startOptions: { executionPolicyFingerprint: agentSessionExecutionPolicyFingerprint(policy) },
    creator: { kind: 'system' },
    maxDepth: 9
  }).dispatch.id
  const identity = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: HOST_TEST_SESSION,
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey(HOST_TEST_SESSION),
    processIncarnation: structuredWorkerProcessIncarnation(HOST_TEST_SESSION),
    worktreeId: 'workspace-1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: identity.worktreeId,
    effects: [],
    setupState: 'not_configured',
    hostScope: JSON.stringify(identity.hostScope),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatchId)
  const request = {
    sessionId: HOST_TEST_SESSION,
    location: { ...HOST_TEST_LOCATION, workspaceKind: 'folder' as const },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/test/advisor-account' },
    expectedFence: null,
    spawnToken: 'execution-spawn',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'pid-absent' as const },
    operation: {
      callerKey: 'advisor-test',
      operationId: `${HOST_TEST_NOW}-00000000000000000000000000000001`,
      fingerprint: 'advisor'
    },
    now: HOST_TEST_NOW,
    options: { model: policy.model, effort: policy.effort },
    executionPolicy: policy
  }
  await rig.store.founding.commit(request)
  const reserved = await rig.store.reserveOwner({
    ...request,
    expectedFence: 1,
    operation: {
      ...request.operation,
      operationId: `${HOST_TEST_NOW}-00000000000000000000000000000002`
    }
  })
  fence = reserved.record.lease.runtimeFence
  await rig.store.commitProcessIdentity({
    sessionId: HOST_TEST_SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'execution-spawn'
    },
    now: HOST_TEST_NOW
  })
  await rig.store.proveOwner({
    sessionId: HOST_TEST_SESSION,
    fence,
    link: {
      linkId: 'advice-link',
      handle: codexProviderHandle('thread-one'),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    },
    now: HOST_TEST_NOW
  })
  const receipt = {
    version: 1 as const,
    spawnTokenHash: createHash('sha256').update('execution-spawn').digest('hex'),
    invalidated: false,
    turnCompleted: false,
    execution: {
      version: 1 as const,
      agent: 'codex' as const,
      modelProvider: 'openai' as const,
      sessionId: HOST_TEST_SESSION,
      runtimeFence: fence,
      acquisitionGeneration: 'execution-generation',
      observedAt: HOST_TEST_NOW,
      cwd: '/test/repo',
      model: 'model-one',
      effort: 'low',
      runtimeWorkspaceRoots: ['/test/repo'],
      account: { type: 'chatgpt' as const, plan: 'pro', fingerprint: policy.accountFingerprint },
      bounded: {
        policyFingerprint: agentSessionExecutionPolicyFingerprint(policy),
        deadlineAt: policy.deadlineAt,
        toolsIsolated: true,
        inputAdmitted: true,
        workspaceRootsSource: 'thread-open' as const
      },
      permissions: {
        activeProfile: { id: `orca-bounded-${HOST_TEST_SESSION}` },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly' as const, networkAccess: false as const }
      }
    }
  }
  await rig.store.recordExecutionReceipt({
    sessionId: HOST_TEST_SESSION,
    fence,
    generation: 'execution-generation',
    spawnToken: 'execution-spawn',
    receipt
  })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  await rig.dispose()
  db.close()
  vi.clearAllMocks()
})

function publisher() {
  return createExecutionReportPublisher(runtime)({
    sessionId: HOST_TEST_SESSION,
    fence,
    spawnToken: 'execution-spawn',
    currentGeneration: () => generation
  })
}
it('reports once against the captured native Dispatch without ambient CLI credentials', async () => {
  const publish = publisher()
  await publish({ status: 'succeeded', summary: 'All admitted checks passed.' })
  expect(db.getTask(taskId)?.status).toBe('completed')
  expect(db.getTask(parentTaskId)?.status).toBe('dispatched')
  await expect(publish({ status: 'succeeded', summary: 'Duplicate.' })).rejects.toThrow('authority')
  expect(db.db.prepare('SELECT id FROM messages').all()).toHaveLength(1)
})
it.each(['generation', 'host', 'deadline', 'policy', 'stop'] as const)(
  'refuses a report after %s custody changes',
  async (changed) => {
    const publish = publisher()
    if (changed === 'generation') {
      generation = 'foreign'
    }
    if (changed === 'host') {
      setStructuredAgentSessionHost(null)
    }
    if (changed === 'deadline') {
      rig.clock.now += 120_001
    }
    if (changed === 'policy') {
      await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
        ...record,
        executionPolicy: { ...record.executionPolicy!, sourcePin: 'c'.repeat(40) }
      }))
    }
    if (changed === 'stop') {
      db.beginWorkerStop(dispatchId, 'test-runtime')
    }
    await expect(
      publish({ status: 'succeeded', summary: 'Must not be delivered.' })
    ).rejects.toThrow('authority')
    expect(db.db.prepare('SELECT id FROM messages').all()).toEqual([])
  }
)

it('reads final proof from the native record and strips its private custody hash', async () => {
  const before = rig.store.getRecord(HOST_TEST_SESSION)!
  const stored = agentSessionExecutionReceiptSchema.parse(before.executionReceipt)
  const executable = { path: '/native/codex', sha256: 'e'.repeat(64), version: '0.167.2' }
  await rig.store.recordExecutionReceipt({
    sessionId: HOST_TEST_SESSION,
    fence,
    generation: 'execution-generation',
    spawnToken: 'execution-spawn',
    receipt: {
      ...stored,
      runtime: { runtimeId: 'qualification-runtime', pid: process.pid, buildHash: 'd'.repeat(16) },
      execution: { ...stored.execution, executable },
      closure: { root: 'exited', tree: 'exited', observedAt: HOST_TEST_NOW + 1_000 }
    }
  })
  await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
    ...record,
    lease: {
      ...record.lease,
      runtimeFence: record.lease.runtimeFence + 1,
      claimStatus: 'released' as const,
      ownerProcess: null,
      reservedSpawnToken: null
    }
  }))
  const metadata = {
    executable,
    observedAt: HOST_TEST_NOW + 2_000,
    account: { fingerprint: `codex:${'b'.repeat(64)}`, plan: 'pro' },
    catalog: [{ model: 'model-one', efforts: ['low'] }],
    limits: [{ bucket: 'primary', remaining: 0.8, resetAt: HOST_TEST_NOW / 1000 + 10_000 }]
  }
  rig.host.deps.adapter!.readExecutionQualification = async () => metadata
  const result = await readWorkerExecutionReceipt(rig.host, db, dispatchId, 'qualification-runtime')
  expect(result).toMatchObject({
    kind: 'execution-receipt',
    sessionId: HOST_TEST_SESSION,
    runtimeFence: fence,
    qualification: {
      runtime: { runtimeId: 'qualification-runtime', buildHash: 'd'.repeat(16) },
      metadata,
      receipt: { closure: { root: 'exited', tree: 'exited' } }
    }
  })
  expect(JSON.stringify(result)).not.toContain('spawnTokenHash')
  expect(JSON.stringify(result)).not.toContain('execution-spawn')
  rig.host.deps.adapter!.readExecutionQualification = async () => null
  await expect(
    readWorkerExecutionReceipt(rig.host, db, dispatchId, 'qualification-runtime')
  ).resolves.toMatchObject({
    kind: 'execution-receipt',
    qualification: { metadata: null, receipt: { closure: { root: 'exited', tree: 'exited' } } }
  })
  await expect(
    readWorkerExecutionReceipt(rig.host, db, dispatchId, 'successor-runtime')
  ).resolves.toMatchObject({
    kind: 'execution-receipt',
    qualification: { runtime: { runtimeId: 'qualification-runtime' } }
  })
  await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
    ...record,
    lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
  }))
  await expect(
    readWorkerExecutionReceipt(rig.host, db, dispatchId, 'qualification-runtime')
  ).resolves.toEqual({ kind: 'unknown', reason: 'identity_changed' })
})
