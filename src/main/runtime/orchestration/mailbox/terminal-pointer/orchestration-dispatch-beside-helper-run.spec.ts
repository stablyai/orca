import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  LAUNCH_TOKEN,
  PANE_KEY,
  PTY_ID,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

const PARENT_PANE = '99999999-9999-4999-8999-999999999999:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREIGN_PANE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('a worker terminal that also coordinates a helper Run', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function parentDispatch(
    db: ReturnType<typeof createDatabase>,
    assigneeHandle: string,
    assigneePane: string
  ) {
    const parent = db.createRun({
      objective: 'parent',
      coordinatorHandle: 'term_parent',
      coordinatorPaneKey: PARENT_PANE
    })
    const task = db.createTask({ spec: 'worker task', runId: parent.id })
    return createRootDispatch(db, task.id, assigneeHandle, assigneePane)
  }

  function insertDispatchReply(
    db: ReturnType<typeof createDatabase>,
    dispatchId: string,
    runId: string
  ) {
    return db.insertMessage({
      from: 'term_parent',
      to: `dispatch:${dispatchId}`,
      subject: 'parent reply',
      type: 'status',
      runId
    })
  }

  it('types a pointer that names the parent Dispatch when helper Run is the default', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-beside-helper-')
    const harness = createRuntime(db)
    const dispatch = parentDispatch(db, TERMINAL_HANDLE, PANE_KEY)
    createBoundRun(db, 'helper')
    await driveToLiveIdle(harness.runtime)

    const reply = insertDispatchReply(db, dispatch.id, dispatch.run_id)
    harness.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, reply.type)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --dispatch ${dispatch.id}`)
    )
    db.close()
  })

  it('points at parent Dispatch mail that arrived before the idle edge', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-dispatch-beside-helper-idle-')
    const harness = createRuntime(db)
    const dispatch = parentDispatch(db, TERMINAL_HANDLE, PANE_KEY)
    createBoundRun(db, 'helper')
    insertDispatchReply(db, dispatch.id, dispatch.run_id)

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --dispatch ${dispatch.id}`)
    )
    db.close()
  })

  it('does not type a pointer for a Dispatch owned by another terminal', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-foreign-dispatch-')
    const harness = createRuntime(db)
    const foreign = parentDispatch(db, 'term_other', FOREIGN_PANE)
    createBoundRun(db, 'helper')
    await driveToLiveIdle(harness.runtime)

    const reply = insertDispatchReply(db, foreign.id, foreign.run_id)
    harness.runtime.notifyMessageArrived(`dispatch:${foreign.id}`, reply.type)
    await vi.advanceTimersByTimeAsync(500)

    const typed = harness.write.mock.calls.map(([, payload]) => String(payload)).join('\n')
    expect(typed).not.toContain(foreign.id)
    db.close()
  })

  it('reads the parent Dispatch with --dispatch while a plain check stays on the helper Run', async () => {
    const db = createDatabase('orca-dispatch-check-')
    const harness = createRuntime(db)
    const dispatch = parentDispatch(db, TERMINAL_HANDLE, PANE_KEY)
    const helper = createBoundRun(db, 'helper')
    // A federated worker has no local assignee Run, so a plain check stays on the helper Run.
    sqliteFor(db)
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
         ) VALUES (?, 'env_pi', 'pi', 'peer', 3)`
      )
      .run(dispatch.id)
    const reply = insertDispatchReply(db, dispatch.id, dispatch.run_id)
    const dispatcher = new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    })
    const call = (params: { dispatch?: string }) =>
      dispatcher.dispatch({
        id: 'req-dispatch-beside-helper',
        authToken: 'test-auth-token',
        method: 'orchestration.check',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationCompatibilityEvidence: {
          terminalHandle: TERMINAL_HANDLE,
          paneKey: PANE_KEY,
          launchToken: LAUNCH_TOKEN
        },
        params: { terminal: TERMINAL_HANDLE, ...params }
      })

    const plain = await call({})
    const named = await call({ dispatch: dispatch.id })

    expect(named).toMatchObject({
      ok: true,
      result: {
        count: 1,
        messages: [expect.objectContaining({ id: reply.id })]
      }
    })
    expect(plain).toMatchObject({ ok: true, result: { runId: helper.id, count: 0 } })
    db.close()
  })

  it('refuses --dispatch for a Dispatch this terminal does not own', async () => {
    const db = createDatabase('orca-foreign-dispatch-check-')
    const harness = createRuntime(db)
    const foreign = parentDispatch(db, 'term_other', FOREIGN_PANE)
    createBoundRun(db, 'helper')
    const response = await new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    }).dispatch({
      id: 'req-foreign-dispatch',
      authToken: 'test-auth-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: LAUNCH_TOKEN
      },
      params: { terminal: TERMINAL_HANDLE, dispatch: foreign.id }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    db.close()
  })
})
