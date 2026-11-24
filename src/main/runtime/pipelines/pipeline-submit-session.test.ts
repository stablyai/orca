import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  ADDRESS_X,
  WORKSPACE_X,
  sessionRecord,
  type SessionCallerHarness
} from './testing/pipeline-session-caller.test-fixture'
import { RpcDispatcher } from '../rpc/dispatcher'
import { PIPELINE_METHODS } from '../rpc/methods/pipelines/pipelines'
import { PipelineStore } from './pipeline-store'
import { PipelineController } from './pipeline-controller'
import { stageEvidence } from './pipeline-evidence.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
let h: SessionCallerHarness
let store: PipelineStore
let dispatcher: RpcDispatcher
let runId: string
let dispatchId: string

beforeEach(() => {
  h = createSessionCallerHarness(hostRef)
  store = new PipelineStore(':memory:')
  const run = store.create({
    requestId: 'create',
    task: 'Fix delivery',
    workspace: {
      id: WORKSPACE_X,
      instanceId: 'instance',
      projectId: 'repo',
      hostId: 'local',
      path: '/project/task'
    },
    profile: {
      id: 'standard',
      version: '1',
      title: 'Development',
      checks: ['test'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
    }
  })
  runId = run.id
  const nativeRun = h.db.createRun({
    objective: 'Pipeline plan',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const task = h.db.createTask({ spec: 'Plan delivery', runId: nativeRun.id })
  dispatchId = h.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: ADDRESS_X,
    creator: { kind: 'system' },
    maxDepth: 1
  }).id
  store.command(run.id, {
    requestId: 'bind',
    expectedRevision: 0,
    command: { kind: 'dispatch', dispatchId, sessionId: ADDRESS_X }
  })
  const controller = new PipelineController(store, {
    start: async () => {
      throw new Error('Unexpected worker launch')
    },
    settled: async () => false,
    sourceRevision: async () => 'a'.repeat(40),
    reviewCommit: async () => 'c'.repeat(40),
    checks: async () => ({ passed: true, body: 'test: exit 0' })
  })
  Object.defineProperty(h.runtime, 'pipelineRuntime', {
    value: { store, controller, assertWorkspace: async () => {}, wake: () => {} }
  })
  dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: PIPELINE_METHODS })
})
afterEach(() => {
  store.close()
  h.close()
  vi.restoreAllMocks()
})

function submit(sessionId: string) {
  return dispatcher.dispatch(
    orchestrationRequest(
      'pipeline.submit',
      {
        id: runId,
        mutation: {
          requestId: 'result',
          expectedRevision: 1,
          command: {
            kind: 'submit',
            dispatchId,
            inputRevision: 0,
            sourceRevision: 'a'.repeat(40),
            body: 'Plan evidence',
            evidence: stageEvidence('plan'),
            verdict: 'pass'
          }
        }
      },
      { sessionId }
    )
  )
}

it('accepts session-only CLI evidence from the assigned structured worker through native dispatcher admission', async () => {
  expect(await submit(SESSION_X)).toMatchObject({
    ok: true,
    result: { run: { stage: 'implement' } }
  })
  expect(store.get(runId).artifacts[0].evidence).toEqual({
    stage: 'plan',
    criteria: ['No duplicate delivery'],
    steps: ['Implement a receipt check and regression']
  })
})

it('rejects a different session, foreign execution owner and unreconciled lease without accepting a stage', async () => {
  expect(await submit(SESSION_Y)).toMatchObject({ ok: false })
  h.records.set(
    SESSION_X,
    sessionRecord(SESSION_X, { location: { executionHostId: 'ssh:foreign' } })
  )
  expect(await submit(SESSION_X)).toMatchObject({ ok: false })
  h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { unreconciled: true } }))
  expect(await submit(SESSION_X)).toMatchObject({ ok: false })
  expect(store.get(runId).stage).toBe('plan')
  expect(store.get(runId).artifacts).toEqual([])
})
