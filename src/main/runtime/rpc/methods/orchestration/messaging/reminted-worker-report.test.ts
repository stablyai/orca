// A restarted runtime can reissue a surviving worker PTY's handle while the worker keeps reporting with its env handle.
// Env handle/pane are caller-selected consistency evidence, not caller authentication; the profile token is the boundary.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { DispatchContextRow } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration/orchestration-compatibility-evidence'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const STALE_HANDLE = 'term_exported-before-restart'
const REMINTED_HANDLE = 'term_reissued-after-restart'
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const OTHER_PANE = 'tab_other:22222222-2222-4222-8222-222222222222'
const PTY_ID = 'wt::/repo/worker@@restored1'
const INCARNATION = `${PTY_ID}:inc-original`
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

describe('worker reports after a restart reissues the worker terminal handle', () => {
  const harness = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = harness
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    harness.cleanup()
  })

  /** The PTY survived the restart; only its handle changed. `paneIncarnation` is what the runtime now records for the pane. */
  function setup(paneIncarnation = INCARNATION): { taskId: string; dispatch: DispatchContextRow } {
    ;({ db, runtime, ctx } = harness.setup())
    const task = db.createTask({ spec: 'long worker task spanning a restart' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      STALE_HANDLE,
      WORKER_PANE,
      undefined,
      INCARNATION
    )
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(HOST_SCOPE, dispatch.id)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === REMINTED_HANDLE ? WORKER_PANE : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === REMINTED_HANDLE ? paneIncarnation : null
    )
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneKey === WORKER_PANE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockImplementation(
      (incarnation, hostScope) =>
        incarnation === paneIncarnation && hostScope === HOST_SCOPE ? REMINTED_HANDLE : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    return { taskId: task.id, dispatch }
  }

  function workerEnv(
    evidence: OrchestrationCompatibilityEvidence = {
      terminalHandle: STALE_HANDLE,
      paneKey: WORKER_PANE,
      launchToken: 'launch-token'
    }
  ): RpcContext {
    return { ...ctx, orchestrationCompatibilityEvidence: evidence }
  }

  async function sendWorkerDone(
    taskId: string,
    dispatchId: string,
    callerCtx: RpcContext
  ): Promise<unknown> {
    return await harness.call(
      'orchestration.send',
      {
        from: STALE_HANDLE,
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      },
      callerCtx
    )
  }

  it('settles worker_done from the recorded process incarnation after its handle was reissued', async () => {
    const { taskId, dispatch } = setup()

    const result = await sendWorkerDone(taskId, dispatch.id, workerEnv())

    expect(result).not.toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(result).toMatchObject({ message: { type: 'worker_done' } })
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(db.getTask(taskId)?.status).toBe('completed')
  })

  it('admits an escalation from the recorded process incarnation after its handle was reissued', async () => {
    const { taskId, dispatch } = setup()

    const escalation = await harness.call(
      'orchestration.send',
      {
        from: STALE_HANDLE,
        subject: 'Blocked',
        type: 'escalation',
        payload: JSON.stringify({ taskId, dispatchId: dispatch.id })
      },
      workerEnv()
    )

    expect(escalation).not.toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(escalation).toMatchObject({ message: { type: 'escalation' } })
  })

  it('still refuses when the worker pane records a replacement incarnation', async () => {
    const { taskId, dispatch } = setup(`${PTY_ID}:inc-replacement`)

    const result = await sendWorkerDone(taskId, dispatch.id, workerEnv())

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it.each([
    ['no env evidence', undefined],
    ['env naming another pane', { terminalHandle: STALE_HANDLE, paneKey: OTHER_PANE }],
    ['env naming another handle', { terminalHandle: 'term_other', paneKey: WORKER_PANE }]
  ] as const)('refuses a stale-handle report with %s', async (_label, evidence) => {
    const { taskId, dispatch } = setup()
    const callerCtx = evidence ? workerEnv(evidence) : ctx

    const result = await sendWorkerDone(taskId, dispatch.id, callerCtx)

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('does not reinterpret a handle that still names another live pane', async () => {
    const { taskId, dispatch } = setup()
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === STALE_HANDLE
          ? OTHER_PANE
          : handle === REMINTED_HANDLE
            ? WORKER_PANE
            : null
    )

    const result = await sendWorkerDone(taskId, dispatch.id, workerEnv())

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
  })

  it('creates a question from the recorded process incarnation after its handle was reissued', async () => {
    setup()
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

    const asked = await harness.call(
      'orchestration.ask',
      { from: STALE_HANDLE, question: 'Proceed?', timeoutMs: 1 },
      workerEnv()
    )

    expect(asked).toMatchObject({ messageId: expect.stringMatching(/^msg_/), timedOut: true })
  })

  it('refuses a question when the worker pane records a replacement incarnation', async () => {
    setup(`${PTY_ID}:inc-replacement`)
    vi.spyOn(runtime, 'waitForMessage').mockResolvedValue('timed_out')

    await expect(
      harness.call(
        'orchestration.ask',
        { from: STALE_HANDLE, question: 'Proceed?', timeoutMs: 1 },
        workerEnv()
      )
    ).rejects.toMatchObject({ code: 'worker_identity_changed' })
  })
})
