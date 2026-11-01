import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcContext } from '../../../core'
import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type { OrchestrationCompatibilityCallerAuthority } from '../../../../runtime-terminal-contracts'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

const OLD_WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const NEW_WORKER_PANE = 'tab_worker:22222222-2222-4222-8222-222222222222'
const STRANGER_PANE = 'tab_stranger:33333333-3333-4333-8333-333333333333'

describe('orchestration.dispatchRebind', () => {
  const h = createOrchestrationRpcHarness()
  const { coordinatorPaneKey } = h
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup())
    mockLiveTerminals(['term_coord', 'term_worker_old', 'term_worker_new', 'term_stranger'])
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
  }

  /** Which terminals are live right now; closed terminals resolve no pane. */
  function mockLiveTerminals(handles: string[]): void {
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker_old'
          ? OLD_WORKER_PANE
          : handle === 'term_worker_new'
            ? NEW_WORKER_PANE
            : handle === 'term_stranger'
              ? STRANGER_PANE
              : handles.includes(handle)
                ? 'tab_fallback:44444444-4444-4444-8444-444444444444'
                : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle.startsWith('term_')
        ? {
            runtimeId: 'runtime_test',
            terminalHandle: handle,
            ptyId: `pty_${handle}`,
            worktreeId: 'wt_test',
            processIncarnation: `runtime_test:${handle}:1`,
            paneKey:
              handle === 'term_coord'
                ? coordinatorPaneKey
                : handle === 'term_worker_old'
                  ? OLD_WORKER_PANE
                  : handle === 'term_worker_new'
                    ? NEW_WORKER_PANE
                    : handle === 'term_stranger'
                      ? STRANGER_PANE
                      : null,
            launchTokenHash: 'launch_hash',
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
  }

  /** Attest exactly one caller identity; any other evidence fails verification. */
  function attestAs(handle: string, paneKey: string): void {
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) =>
      evidence?.terminalHandle === handle
        ? ({
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey,
            terminalHandle: handle,
            processIncarnation: `runtime_test:${handle}:1`,
            launchTokenHash: 'launch_hash'
          } as OrchestrationCompatibilityCallerAuthority)
        : null
    )
  }

  function callerContext(evidence: OrchestrationCompatibilityEvidence): RpcContext {
    return { ...ctx, orchestrationCompatibilityEvidence: evidence }
  }

  async function rebind(
    evidence: OrchestrationCompatibilityEvidence,
    params: { dispatch: string; to: string }
  ) {
    return h.call('orchestration.dispatchRebind', params, callerContext(evidence))
  }

  afterEach(() => {
    h.cleanup()
  })

  it('moves an active Dispatch to a successor terminal, whose worker_done then settles', async () => {
    setup()
    attestAs('term_worker_old', OLD_WORKER_PANE)
    const task = db.createTask({ spec: 'long worker task' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )

    // The old terminal closes before the rebind: its handle no longer resolves.
    mockLiveTerminals(['term_coord', 'term_worker_new'])

    const result = (await rebind(
      { terminalHandle: 'term_worker_old', paneKey: OLD_WORKER_PANE, launchToken: 'token' },
      { dispatch: dispatch.id, to: 'term_worker_new' }
    )) as { dispatch: { id: string; assignee_handle: string; assignee_pane_key: string } }

    expect(result.dispatch).toMatchObject({
      id: dispatch.id,
      assignee_handle: 'term_worker_new',
      assignee_pane_key: NEW_WORKER_PANE
    })

    // Closing the old terminal must not fail the Dispatch afterwards: the exit hook matches by
    // assignee identity (getActiveDispatchForTerminal), which now names only the successor.
    expect(db.getActiveDispatchForTerminal('term_worker_old', OLD_WORKER_PANE)).toBeUndefined()
    expect(db.getActiveDispatchForTerminal('term_worker_new', NEW_WORKER_PANE)?.id).toBe(
      dispatch.id
    )

    // The successor reports as itself while the old terminal stays closed.
    const done = (await h.call(
      'orchestration.send',
      {
        from: 'term_worker_new',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      },
      ctx
    )) as { lifecycle: { action: string } }

    expect(done.lifecycle).toMatchObject({ action: 'completed' })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })

  it('lets the Run coordinator terminal move the Dispatch', async () => {
    setup()
    attestAs('term_coord', coordinatorPaneKey)
    const task = db.createTask({ spec: 'coordinator handoff' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )

    const result = (await rebind(
      { terminalHandle: 'term_coord', paneKey: coordinatorPaneKey, launchToken: 'token' },
      { dispatch: dispatch.id, to: 'term_worker_new' }
    )) as { dispatch: { assignee_handle: string } }

    expect(result.dispatch).toMatchObject({ assignee_handle: 'term_worker_new' })
  })

  it('refuses an attested terminal that is neither the assignee nor the Run coordinator', async () => {
    setup()
    attestAs('term_stranger', STRANGER_PANE)
    const task = db.createTask({ spec: 'unrelated caller' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )

    await expect(
      rebind(
        { terminalHandle: 'term_stranger', paneKey: STRANGER_PANE, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses an unattested caller instead of trusting the claimed handle', async () => {
    setup()
    attestAs('term_worker_old', OLD_WORKER_PANE)
    const task = db.createTask({ spec: 'unattested caller' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )

    await expect(
      rebind(
        { terminalHandle: 'term_worker_new', paneKey: NEW_WORKER_PANE, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses a target terminal without a stable pane and process incarnation', async () => {
    setup()
    attestAs('term_worker_old', OLD_WORKER_PANE)
    const task = db.createTask({ spec: 'unstable target' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )
    mockLiveTerminals(['term_coord', 'term_worker_old', 'term_worker_new'])
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
      handle === 'term_worker_new'
        ? {
            runtimeId: 'runtime_test',
            terminalHandle: handle,
            ptyId: `pty_${handle}`,
            worktreeId: 'wt_test',
            processIncarnation: null,
            paneKey: null,
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )

    await expect(
      rebind(
        { terminalHandle: 'term_worker_old', paneKey: OLD_WORKER_PANE, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'stable_pane_required' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses a target terminal that already owns another active Dispatch', async () => {
    setup()
    attestAs('term_coord', coordinatorPaneKey)
    const task = db.createTask({ spec: 'busy target' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )
    const otherTask = db.createTask({ spec: 'another active task' })
    createRootDispatch(
      db,
      otherTask.id,
      'term_worker_new',
      NEW_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_new:1'
    )

    await expect(
      rebind(
        { terminalHandle: 'term_coord', paneKey: coordinatorPaneKey, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses a Dispatch supervised by a connected server', async () => {
    setup()
    attestAs('term_coord', coordinatorPaneKey)
    const task = db.createTask({ spec: 'remote worker' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint)
         VALUES (?, ?, ?, ?)`
      )
      .run(dispatch.id, 'env_1', 'Server', 'fingerprint')

    await expect(
      rebind(
        { terminalHandle: 'term_coord', paneKey: coordinatorPaneKey, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses a Dispatch held by an agent session instead of a terminal', async () => {
    setup()
    attestAs('term_coord', coordinatorPaneKey)
    const task = db.createTask({ spec: 'session worker' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run('orca:session_worker', dispatch.id)

    await expect(
      rebind(
        { terminalHandle: 'term_coord', paneKey: coordinatorPaneKey, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })

  it('refuses a Dispatch whose worker is still starting or stopping', async () => {
    setup()
    attestAs('term_coord', coordinatorPaneKey)
    const task = db.createTask({ spec: 'starting worker' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker_old',
      OLD_WORKER_PANE,
      undefined,
      'runtime_test:term_worker_old:1'
    )
    // Defaults to state 'starting', where prepareStartingWorkerAuthority owns the binding.
    db.db.prepare('INSERT INTO worker_dispatches (dispatch_id) VALUES (?)').run(dispatch.id)

    await expect(
      rebind(
        { terminalHandle: 'term_coord', paneKey: coordinatorPaneKey, launchToken: 'token' },
        { dispatch: dispatch.id, to: 'term_worker_new' }
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
    expect(db.getDispatchContextById(dispatch.id)?.assignee_handle).toBe('term_worker_old')
  })
})
