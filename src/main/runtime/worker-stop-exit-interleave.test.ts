import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `${TAB}:${LEAF}`
const PTY = 'pty-stop-race'
const HANDLE = 'term_stop_race'
const WORKTREE = 'repo::folder'

describe('intentional worker-stop with PTY exit during close', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatchId: string
  let alive: boolean
  let closeCount: number

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    alive = true
    closeCount = 0
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        alive ? ([{ id: PTY, incarnationId: 'incarnation-1' }] as never) : [],
      stopAndWait: async (ptyId) => {
        closeCount += 1
        alive = false
        runtime.onPtyExit(ptyId, 0, 'incarnation-1')
        return true
      }
    })
    runtime.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: 'incarnation-1'
    })
    runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: TAB, worktreeId: WORKTREE, title: 'Worker', activeLeafId: LEAF, layout: null }
      ],
      leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId: PTY }]
    })
    const run = db.createRun({
      objective: 'Stop race',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'stop the worker', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 10,
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    dispatchId = started.dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: HANDLE,
      paneKey: PANE,
      processIncarnation: `${PTY}:incarnation-1`,
      worktreeId: WORKTREE,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    db.markWorkerDispatchReady(dispatchId)
  })

  afterEach(() => db.close())

  async function call(name: string) {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === name)!
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime })
  }

  it('settles the same intentional stop and releases its dead resource without re-closing', async () => {
    await expect(call('orchestration.workerStop')).resolves.toMatchObject({
      state: 'stopped',
      processAction: 'closed_agent_terminal'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stopped',
      stage: 'process_stopped'
    })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped',
      failure_count: 0
    })
    expect(db.getDispatchContextById(dispatchId)?.capability_revoked_at).not.toBeNull()
    await expect(call('orchestration.workerStop')).resolves.toMatchObject({
      state: 'stopped',
      alreadySettled: true,
      processAction: 'none'
    })
    await expect(call('orchestration.workerRelease')).resolves.toMatchObject({
      state: 'released',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released'
    })
    expect(closeCount).toBe(1)
  })

  it('does not turn a natural crash into a successful stop', async () => {
    runtime.onPtyExit(PTY, 1, 'incarnation-1')
    await expect(call('orchestration.workerStop')).resolves.toMatchObject({
      state: 'failed',
      alreadySettled: true
    })
    expect(db.getWorkerDispatch(dispatchId)?.stage).toBe('process_exited')
    expect(closeCount).toBe(0)
  })

  it('keeps a proven stop authoritative when the close promise later rejects', async () => {
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, 0, 'incarnation-1')
        throw new Error('close response lost after exit')
      }
    })
    await expect(call('orchestration.workerStop')).resolves.toMatchObject({ state: 'stopped' })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(db.markWorkerStopUnknown(dispatchId, 'late error').state).toBe('stopped')
    expect(db.settleWorkerStop(dispatchId).state).toBe('stopped')
  })

  it('never promotes an unrelated failed dispatch to stopped', () => {
    db.failDispatch(dispatchId, 'crash', { workerProcessExited: true })
    expect(() => db.settleWorkerStop(dispatchId)).toThrow('is not stopping')
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('does not assign another process exit to the recorded worker stop', () => {
    db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    runtime.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId: 'replacement'
    })
    runtime.markPtyStopRequested(PTY)
    runtime.onPtyExit(PTY, 0, 'replacement')
    expect(db.getWorkerDispatch(dispatchId)?.state).not.toBe('stopped')
  })

  it('ignores a stale exit for a replaced incarnation during stop intent', () => {
    db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    runtime.markPtyStopRequested(PTY)
    runtime.onPtyExit(PTY, 0, 'stale-incarnation')
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopping')
  })

  it('does not certify an unconfirmed stop as stopped', () => {
    db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    runtime.markPtyStopRequested(PTY)
    runtime.onPtyExit(PTY, -1, 'incarnation-1')
    expect(db.getWorkerDispatch(dispatchId)?.state).not.toBe('stopped')
  })
})
