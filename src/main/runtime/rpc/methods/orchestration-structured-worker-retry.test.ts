import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { HOST_TEST_NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { CodexAppServerRequestError } from '../../../codex/app-server/codex-app-server-request-error'
import { OrchestrationDb } from '../../orchestration/db'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession
} from './orchestration-structured-worker-session'
import { deliverWorkerDispatchPreamble } from './orchestration/worker/deliver-worker-dispatch-preamble'
import { tearDownFailedWorkerStart } from './orchestration/worker/failed-worker-start-teardown'
import { structuredWorkerIdentities } from '../../structured-worker-identity'
import { rpcContext, runtimeStub } from './agent-launch.test-fixture'

let rig: RestTestRig
let db: OrchestrationDb
beforeEach(async () => {
  vi.useFakeTimers({ now: HOST_TEST_NOW, toFake: ['Date'] })
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const acquire = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementation(async (input) => {
    const acquired = await acquire(input)
    return {
      ...acquired,
      link: {
        ...acquired.link!,
        origin: rig.store.getRecord(input.identity.sessionId)?.providerHandleChain.length
          ? 'resumed'
          : 'created'
      }
    }
  })
  setStructuredAgentSessionHost(rig.host)
  db = new OrchestrationDb(':memory:')
})
afterEach(async () => {
  releaseStructuredWorkerSession('dispatch-retry')
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  db.close()
  vi.useRealTimers()
})

async function createWorker() {
  const workerRuntime = {
    ...runtimeStub(),
    resolveStructuredAgentSessionCreateIntent: async (params: { envelope: unknown }) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      options: { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    }),
    publishStructuredAgentSessionTab: async () => {},
    getNestedWorkerMaxDepth: () => 2,
    getOrchestrationHeartbeatMinutes: () => 5,
    getTerminalOrchestrationCliCommand: () => 'orca',
    orchestrationSenderNames: { nameOf: () => 'Coordinator' },
    forgetStructuredSessionMail: vi.fn(),
    retireStructuredAgentSessionTabFromSnapshot: vi.fn(() => true)
  }
  const runtime = rpcContext(workerRuntime, {}).runtime
  const created = await createStructuredWorkerSession({
    runtime,
    worktreeId: 'wt-7',
    agent: 'codex',
    dispatchId: 'dispatch-retry',
    onJournalActivity: () => {}
  })
  const deliverPreamble = () =>
    deliverWorkerDispatchPreamble({
      runtime,
      db,
      structuredSession: created,
      terminalHandle: created.identity.handle,
      dispatchId: 'dispatch-retry',
      dispatchDepth: 1,
      runId: 'run-retry',
      taskId: 'task-retry',
      taskSpec: 'fix the build',
      coordinatorHandle: 'term_coordinator',
      devMode: false,
      requestId: 'request-retry',
      readinessTimeoutMs: 2000
    })
  return { runtime, created, workerRuntime, deliverPreamble }
}

it('starts only for its agent-sourced preamble and observes it after a transient open failure', async () => {
  const { created, deliverPreamble } = await createWorker()
  const sessionId = created.identity.sessionId
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  expect((await rig.host.journalSnapshot(sessionId)).submissions).toEqual([])
  vi.spyOn(rig.host.deps.adapter, 'open').mockRejectedValueOnce(
    new CodexAppServerRequestError('initialize', -32603, 'temporarily unavailable')
  )
  const result = await deliverPreamble()
  expect(result.structuredTurnStart).toEqual({ verdict: 'observed' })
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
  const snapshot = await rig.host.journalSnapshot(sessionId)
  expect(snapshot.submissions).toMatchObject([
    {
      dispatchState: 'accepted',
      source: { kind: 'agent' }
    }
  ])
  expect(snapshot.submissions).toHaveLength(1)
  const [input] = rig.adapter.dispatch.mock.calls[0]!
  expect(input).toMatchObject({
    body: {
      from: {
        kind: 'agent',
        senders: [{ name: 'Coordinator' }],
        orchestration: { message: 'task', dispatchId: 'dispatch-retry' }
      }
    }
  })
  expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([])
})

it('reports a preamble as undelivered after startup exhaustion and retires the failed worker', async () => {
  const { runtime, created, workerRuntime, deliverPreamble } = await createWorker()
  const sessionId = created.identity.sessionId
  expect(rig.store.listVisibleSessionIds()).toContain(sessionId)
  vi.spyOn(rig.host.deps.adapter, 'open').mockRejectedValue(
    new CodexAppServerRequestError('initialize', -32603, 'temporarily unavailable')
  )
  await expect(deliverPreamble()).rejects.toMatchObject({ code: 'dispatch_preamble_undelivered' })
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(5)
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  const snapshot = await rig.host.journalSnapshot(sessionId)
  expect(snapshot.submissions).toHaveLength(1)
  expect(snapshot.submissions).toMatchObject([
    { dispatchState: 'rejected', source: { kind: 'agent' } }
  ])
  await tearDownFailedWorkerStart({
    runtime,
    structuredSession: created,
    dispatchId: 'dispatch-retry'
  })
  expect(structuredWorkerIdentities.getBySessionId(sessionId)).toBeNull()
  expect(rig.host.hasSession(sessionId)).toBe(false)
  expect(rig.store.listVisibleSessionIds()).not.toContain(sessionId)
  expect(workerRuntime.forgetStructuredSessionMail).toHaveBeenCalledWith(sessionId)
  expect(workerRuntime.retireStructuredAgentSessionTabFromSnapshot).toHaveBeenCalledWith(sessionId)
})
