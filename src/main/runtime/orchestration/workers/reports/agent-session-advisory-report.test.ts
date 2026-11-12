import { agentSessionAdvisoryPolicyFingerprint } from '../../../../../shared/agent-session/agent-session-advisory-policy'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAdvisoryReportPublisher } from './agent-session-advisory-report'
import { readStructuredWorkerSettings } from '../../../rpc/methods/orchestration/worker/session-worker-observation'
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
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../terminal-authority/structured-sessions/structured-worker-identity'

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
  generation = 'advisory-generation'
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
  db = new OrchestrationDb(':memory:')
  const policy = {
    schema: 1 as const,
    dataScope: 'published' as const,
    sourcePin: 'a'.repeat(40),
    deadlineAt: HOST_TEST_NOW + 300_000,
    maxModelCalls: 4,
    artifacts: [
      {
        path: 'note.txt',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
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
    startOptions: { advisoryPolicyFingerprint: agentSessionAdvisoryPolicyFingerprint(policy) },
    creator: { kind: 'system' },
    maxDepth: 9
  }).dispatch.id
  const identity = structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: HOST_TEST_SESSION,
    agent: 'claude',
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
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/test/advisor-account' },
    expectedFence: null,
    spawnToken: 'advisory-spawn',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'pid-absent' as const },
    operation: {
      callerKey: 'advisor-test',
      operationId: `${HOST_TEST_NOW}-00000000000000000000000000000001`,
      fingerprint: 'advisor'
    },
    now: HOST_TEST_NOW,
    advisoryPolicy: policy
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
      spawnToken: 'advisory-spawn'
    },
    now: HOST_TEST_NOW
  })
  await rig.store.proveOwner({
    sessionId: HOST_TEST_SESSION,
    fence,
    link: {
      linkId: 'advice-link',
      handle: claudeProviderHandle('test-provider', null),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: HOST_TEST_NOW
    },
    accountAcquisition: {
      generation: 'advisory-generation',
      recipe: { route: 'system', home: '/test/advisor-account', configDir: null }
    },
    now: HOST_TEST_NOW
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
  return createAdvisoryReportPublisher(runtime)({
    sessionId: HOST_TEST_SESSION,
    fence,
    spawnToken: 'advisory-spawn',
    currentGeneration: () => generation
  })
}

it('exposes the bound policy limits without snapshots or a qualification claim', async () => {
  vi.spyOn(rig.host, 'hasSession').mockReturnValue(true)
  vi.spyOn(rig.host, 'readOptions').mockResolvedValue({ models: [], current: {} })
  const settings = await readStructuredWorkerSettings(
    { ensureStructuredAgentSessionHost: async () => {} },
    db,
    dispatchId
  )
  expect(settings).toMatchObject({
    kind: 'options',
    advisory: {
      sourcePin: 'a'.repeat(40),
      dataScope: 'published',
      deadlineAt: 1_800_000_300_000,
      maxModelCalls: 4,
      qualification: 'unqualified'
    }
  })
  expect(JSON.stringify(settings)).not.toContain('hello')
})

it('discards a readback whose private advisory policy changed during the read', async () => {
  vi.spyOn(rig.host, 'hasSession').mockReturnValue(true)
  vi.spyOn(rig.host, 'readOptions').mockImplementation(async () => {
    await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
      ...record,
      advisoryPolicy: { ...record.advisoryPolicy!, maxModelCalls: 3 }
    }))
    return { models: [], current: {} }
  })
  expect(
    await readStructuredWorkerSettings(
      { ensureStructuredAgentSessionHost: async () => {} },
      db,
      dispatchId
    )
  ).toEqual({ kind: 'unknown', reason: 'identity_changed' })
})

it('settles only the captured advisory Dispatch and delivers its host-bound report', async () => {
  await publisher()({ status: 'inconclusive' })
  expect(db.getTask(taskId)?.status).toBe('completed')
  expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  expect(db.getTask(parentTaskId)?.status).toBe('dispatched')
  const messages = db.db.prepare('SELECT type, body, to_handle FROM messages').all()
  expect(messages).toEqual([
    {
      type: 'worker_done',
      body: JSON.stringify({
        source_pin: 'a'.repeat(40),
        advisor: dispatchId,
        status: 'inconclusive'
      }),
      to_handle: `run:${db.getTask(taskId)!.run_id}`
    }
  ])
})

it.each(['generation', 'host', 'deadline', 'policy', 'stop'] as const)(
  'refuses a report after %s custody changes',
  async (changed) => {
    const publish = publisher()
    if (changed === 'generation') {
      generation = 'foreign-generation'
    }
    if (changed === 'host') {
      setStructuredAgentSessionHost(null)
    }
    if (changed === 'deadline') {
      rig.clock.now += 300_001
    }
    if (changed === 'policy') {
      await rig.store.transitionHandoff(HOST_TEST_SESSION, (record) => ({
        ...record,
        advisoryPolicy: { ...record.advisoryPolicy!, maxModelCalls: 3 }
      }))
    }
    if (changed === 'stop') {
      db.beginWorkerStop(dispatchId, 'test-runtime')
    }
    await expect(publish({ status: 'inconclusive' })).rejects.toThrow()
    expect(db.getTask(taskId)?.status).toBe(changed === 'stop' ? 'blocked' : 'dispatched')
    expect(db.db.prepare('SELECT id FROM messages').all()).toEqual([])
  }
)

it('refuses report authority for an ordinary worker without advisory launch identity', () => {
  db.db
    .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
    .run('{}', dispatchId)
  expect(() => publisher()).toThrow()
  expect(db.getTask(taskId)?.status).toBe('dispatched')
  expect(db.getTask(parentTaskId)?.status).toBe('dispatched')
})

it('never reports against a successor Dispatch that reused the same native worker', async () => {
  const publish = publisher()
  db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'Earlier report' })
  const identity = structuredWorkerIdentities.getBySessionId(HOST_TEST_SESSION)!
  const successorTask = db.createTask({ runId: db.getTask(taskId)!.run_id, spec: 'Successor work' })
  const successor = createRootDispatch(
    db,
    successorTask.id,
    identity.handle,
    identity.paneKey,
    undefined,
    identity.processIncarnation
  )
  await expect(publish({ status: 'inconclusive' })).rejects.toThrow()
  expect(db.getTask(successorTask.id)?.status).toBe('dispatched')
  expect(db.getDispatchContextById(successor.id)?.status).toBe('dispatched')
  expect(db.db.prepare('SELECT id FROM messages').all()).toEqual([])
})
