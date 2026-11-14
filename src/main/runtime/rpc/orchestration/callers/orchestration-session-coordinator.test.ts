import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKSPACE_X,
  type SessionCallerHarness
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

describe('a structured worker that names itself by session id', () => {
  let h: SessionCallerHarness
  const workerSession = SESSION_Y
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(workerSession)

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    structuredWorkerIdentities.register({
      handle,
      sessionId: workerSession,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('exposes stored session identities for an authenticated dispatch', async () => {
    structuredWorkerIdentities.clear()
    const as = async (method: string, params: Record<string, unknown>) =>
      resultOf(await h.dispatch(orchestrationRequest(method, params, { sessionId: SESSION_X })))
    const runId = idOf((await as('orchestration.runCreate', { objective: 'review' })).run)
    const taskId = idOf((await as('orchestration.taskCreate', { spec: 'review work' })).task)
    const dispatchId = idOf(
      (await as('orchestration.dispatch', { task: taskId, to: ADDRESS_Y })).dispatch
    )

    expect(h.db.getDispatchContextById(dispatchId)).toMatchObject({
      run_id: runId,
      creator_orca_session_id: SESSION_X,
      assignee_orca_session_id: SESSION_Y
    })
    expect(await as('orchestration.callerShow', {})).toMatchObject({
      caller: { orcaSessionId: ADDRESS_X }
    })
    expect(await as('orchestration.workerShow', { dispatch: dispatchId })).toMatchObject({
      dispatch: { creatorOrcaSessionId: SESSION_X, assigneeOrcaSessionId: SESSION_Y }
    })
  })

  it('exposes the authenticated creator of a failed worker-start', async () => {
    const as = async (method: string, params: Record<string, unknown>) =>
      resultOf(await h.dispatch(orchestrationRequest(method, params, { sessionId: SESSION_X })))
    const runId = idOf((await as('orchestration.runCreate', { objective: 'review' })).run)
    if (!hostRef.current || typeof hostRef.current !== 'object') {
      throw new Error('Missing structured session test host')
    }
    Object.assign(hostRef.current, { captureAgentStartDestination: () => null })
    vi.spyOn(h.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this failed terminal-create path reads only the workspace identity.
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: WORKSPACE_X
    } as never)
    vi.spyOn(h.runtime, 'createTerminal').mockRejectedValue(new Error('terminal spawn rejected'))

    const started = await as('orchestration.workerStart', {
      run: runId,
      spec: 'worker-start proof',
      agent: 'claude'
    })
    expect(started).toMatchObject({ state: 'failed', failedStage: 'terminal_create' })
    if (typeof started.dispatchId !== 'string') {
      throw new Error('Expected a dispatch id')
    }
    expect(h.db.getDispatchContextById(started.dispatchId)?.creator_orca_session_id).toBe(SESSION_X)
    expect(await as('orchestration.workerShow', { dispatch: started.dispatchId })).toMatchObject({
      dispatch: { creatorOrcaSessionId: SESSION_X, assigneeOrcaSessionId: null }
    })
  })

  it('sends mail at either of its spellings to its Dispatch once assigned in a Run it coordinated before', async () => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: workerSession }
        )
      )
    )
    const runId = idOf(run)
    // A chat takes the Run over; the worker's addresses stay remembered as a former coordinator's.
    resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.runUse', { id: runId }, { sessionId: SESSION_X })
      )
    )
    expect(h.db.getRunMailboxOwnerIdsForHandle(ADDRESS_Y)).toEqual([runId])
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    // Both spellings name one party, so both land in the one mailbox it reads, not the Run's.
    for (const to of [ADDRESS_Y, handle]) {
      const { message } = resultOf(
        await h.dispatch(
          orchestrationRequest('orchestration.send', { to, subject: to }, { sessionId: SESSION_X })
        )
      )
      expect(message).toMatchObject({ to_handle: `dispatch:${dispatch.id}` })
    }
    const read = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: workerSession })
      )
    )
    expect(read).toMatchObject({
      count: 2,
      messages: expect.arrayContaining([
        expect.objectContaining({ subject: handle }),
        expect.objectContaining({ subject: ADDRESS_Y })
      ])
    })
  })
})
