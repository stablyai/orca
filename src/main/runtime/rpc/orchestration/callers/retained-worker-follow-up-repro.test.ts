import { afterEach, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { revealStructuredAgentSession } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-reveal'
import { planWorkerFollowUp } from '../../methods/orchestration/messaging/worker-follow-up'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation,
  structuredWorkerIdentities
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKSPACE_X
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)
const ORIGINAL = testOrcaSessionId('78f238aa-a3bd-41b2-bdcb-f5c116639701')
let h: ReturnType<typeof createSessionCallerHarness> | undefined
afterEach(() => h?.close())

it('reopens the same saved chat after rebinding and exposes duplicate owned resource rows', async () => {
  const visible = [SESSION_X]
  const { db, runtime, records, dispatch } = (h = createSessionCallerHarness(hostRef, () => ({
    present: true,
    sessionIds: visible
  })))
  records.set(ORIGINAL, sessionRecord(ORIGINAL))
  records.set(
    SESSION_Y,
    sessionRecord(SESSION_Y, {
      lease: {
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'observed exit',
          observedAt: 40_000,
          lastProvenAliveAt: 30_000,
          ownerFence: 7
        }
      }
    })
  )
  const opened: string[] = []
  const sent: string[] = []
  const host = hostRef.current as { deps: Parameters<typeof revealStructuredAgentSession>[0] }
  Object.assign(host, {
    isSessionTabVisible: (id: string) => visible.some((item) => item === id),
    revealSession: (id: string) =>
      revealStructuredAgentSession(host.deps, id, async (sessionId) => {
        opened.push(sessionId)
      }),
    send: async (_: unknown, { sessionId }: { sessionId: string }) => {
      sent.push(sessionId)
      return {
        ok: true,
        value: { clientMessageId: 'synthetic', submission: { dispatchState: 'accepted' } }
      }
    }
  })
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: WORKSPACE_X,
    repoId: 'repo_1'
  } as never)
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(
    async ({ sessionId }) => {
      expect(sessionId).toBe(SESSION_Y)
      visible.push(SESSION_Y)
    }
  )
  const run = db.createRun({
    objective: 'Retained worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: ORIGINAL
  })
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
  const processIncarnation = structuredWorkerProcessIncarnation(SESSION_Y)
  const hostScope = JSON.stringify({ kind: 'local', hostId: 'local' })
  const seed = (followUpOf?: string) => {
    const task = db.createTask({ spec: 'Synthetic work', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: ORIGINAL },
      maxDepth: 4,
      taskId: task.id,
      startOptions: { agent: 'codex' },
      runtimeEpoch: runtime.getRuntimeId(),
      followUpOf
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle,
      paneKey,
      processIncarnation,
      hostScope,
      worktreeId: WORKSPACE_X,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: followUpOf ? 'external' : 'created'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch }
  }
  const predecessor = seed()
  expect(
    db.settleWorkerReport({
      taskId: predecessor.task.id,
      dispatchId: predecessor.dispatch.id,
      outcome: 'succeeded',
      result: 'done'
    })
  ).toMatchObject({ action: 'settled' })
  const stopped = seed(predecessor.dispatch.id)
  const held = db.retainWorkerTerminalResource(stopped.dispatch.id).resource!
  db.beginWorkerStop(stopped.dispatch.id, runtime.getRuntimeId())
  db.storeWorkerTerminalArchiveBeforeStop({
    dispatchId: stopped.dispatch.id,
    resourceId: held.id,
    kind: 'structured_journal',
    content: 'synthetic archive',
    archiveSource: 'transcript',
    archiveStatus: 'captured'
  })
  db.settleWorkerStop(stopped.dispatch.id)
  const retained = db.getWorkerTerminalResource(held.id)!
  expect(retained).toMatchObject({
    ownership_state: 'owned',
    release_state: 'retained',
    retained_reason: 'user_requested',
    origin_dispatch_id: predecessor.dispatch.id
  })
  structuredWorkerIdentities.clear()
  const mail = {
    to: `dispatch:${stopped.dispatch.id}`,
    run: run.id,
    type: 'status',
    subject: 'Continue',
    body: 'Synthetic follow-up'
  }
  const send = (requestId: string, sessionId = SESSION_X) =>
    dispatch(orchestrationRequest('orchestration.send', mail, { requestId, sessionId }))
  expect(await send('before-rebind')).toMatchObject({
    ok: false,
    error: { code: 'consumer_fenced' }
  })
  expect(opened).toEqual([])
  expect(sent).toEqual([])
  expect(db.getWorkerTerminalResource(retained.id)).toEqual(retained)

  expect(
    await dispatch(
      orchestrationRequest('orchestration.runUse', { id: run.id }, { sessionId: SESSION_X })
    )
  ).toMatchObject({ ok: true })
  expect(db.getDispatchContextById(predecessor.dispatch.id)).toMatchObject({
    failure_count: 0,
    retry_of_dispatch_id: null
  })
  expect(db.getDispatchContextById(stopped.dispatch.id)).toMatchObject({
    failure_count: 0,
    retry_of_dispatch_id: null
  })
  const accepted = await send('after-rebind')
  const receipt = resultOf(accepted)
  expect(receipt).toMatchObject({
    runId: run.id,
    state: 'ready',
    delivery: 'reopened',
    followUpOf: stopped.dispatch.id
  })
  expect(receipt.taskId).not.toBe(stopped.task.id)
  const next = idOf({ id: receipt.dispatchId })
  expect(opened).toEqual([SESSION_Y])
  expect(sent).toEqual([SESSION_Y])
  expect(db.getDispatchContextById(next)).toMatchObject({
    assignee_handle: handle,
    assignee_orca_session_id: SESSION_Y,
    process_incarnation: processIncarnation,
    creator_orca_session_id: SESSION_X
  })
  expect(db.getWorkerTerminalResource(retained.id)).toEqual(retained)
  const newResource = db.getWorkerTerminalResourceByOwner(next)!
  expect(newResource).toMatchObject({
    owner_dispatch_id: next,
    origin_dispatch_id: next,
    ownership_state: 'owned',
    release_state: 'not_requested',
    retained_reason: null,
    terminal_handle: handle,
    pane_key: paneKey,
    host_scope: hostScope,
    process_incarnation: processIncarnation
  })
  expect(newResource.id).not.toBe(retained.id)
  expect(db.workerTerminalResourceHasIdentityConflict(retained.id)).toBe(true)
  expect(db.workerTerminalResourceHasIdentityConflict(newResource.id)).toBe(true)
  expect(await send('after-rebind')).toMatchObject({ ok: true, result: { dispatchId: next } })
  expect(opened).toEqual([SESSION_Y])
  expect(sent).toEqual([SESSION_Y])
  console.info(JSON.stringify({ retained, newResource, receipt }))
})

it('the send planner can select a new follow-up from a circuit-broken attempt', () => {
  const { db } = (h = createSessionCallerHarness(hostRef))
  const run = db.createRun({
    objective: 'Circuit breaker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: SESSION_X
  })
  const task = db.createTask({ spec: 'Synthetic failing work', runId: run.id })
  let retryOf: string | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: 4,
      retryOf,
      startOptions: {}
    })
    db.failWorkerStart(dispatch.id, 'agent_readiness', 'Synthetic failure')
    retryOf = dispatch.id
  }
  const latest = db.getDispatchContext(task.id)!
  expect(latest).toMatchObject({ status: 'circuit_broken', failure_count: 3 })
  expect(planWorkerFollowUp(db, latest.id, 'status')).toMatchObject({
    kind: 'start',
    latest: { id: latest.id }
  })
})
