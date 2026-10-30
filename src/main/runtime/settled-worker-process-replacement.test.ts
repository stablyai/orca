import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

const TAB = 'worker-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `${TAB}:${LEAF}`
const WORKSPACE = '/folder-workspace'
const LOCAL_HOST = JSON.stringify({ kind: 'local', hostId: 'local' })
const SSH_HOST = JSON.stringify({ kind: 'ssh', targetId: 'remote-host' })
let db: OrchestrationDb
let runtime: OrcaRuntimeService

afterEach(() => {
  db?.close()
})

function seedWorker(hostScope: string, settled = true) {
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec: 'Ordinary pane after worker completion',
    taskRunId: 'run_legacy_local',
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_original',
    paneKey: PANE,
    processIncarnation: 'pty-original:inc-original',
    hostScope,
    worktreeId: WORKSPACE,
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  if (settled) {
    db.settleWorkerReport({
      taskId: started.task.id,
      dispatchId: started.dispatch.id,
      outcome: 'succeeded',
      result: '{}'
    })
  }
  return {
    dispatchId: started.dispatch.id,
    task: db.getTask(started.task.id),
    dispatch: db.getDispatchContextById(started.dispatch.id)
  }
}

function register(ptyId: string, incarnationId?: string, connectionId: string | null = null) {
  runtime.registerPty(ptyId, WORKSPACE, connectionId, {
    tabId: TAB,
    leafId: LEAF,
    ...(incarnationId ? { incarnationId } : {})
  })
}

describe('settled worker process replacement accounting', () => {
  it.each([null, 'remote-host'])(
    'retains the replaced resource on owning host %s',
    (connectionId) => {
      const worker = seedWorker(connectionId ? SSH_HOST : LOCAL_HOST)
      register('pty-resumed', 'inc-resumed', connectionId)
      register('pty-resumed', 'inc-resumed', connectionId)
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
        release_state: 'retained',
        retained_reason: 'identity_unproven',
        process_incarnation: 'pty-original:inc-original'
      })
      expect(db.getTask(worker.task!.id)).toEqual(worker.task)
      expect(db.getDispatchContextById(worker.dispatchId)).toEqual(worker.dispatch)
      expect(db.listWorkerTerminalResources({})).toEqual([
        expect.objectContaining({ dispatchId: worker.dispatchId, terminalState: 'retained' })
      ])
    }
  )

  it('keeps the original live resource unchanged across reattach', () => {
    const worker = seedWorker(LOCAL_HOST)
    const original = db.getWorkerTerminalResourceByOwner(worker.dispatchId)
    register('pty-original', 'inc-original')
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(original)
  })

  it('does not use missing incarnation evidence as proof of replacement', () => {
    const worker = seedWorker(LOCAL_HOST)
    const original = db.getWorkerTerminalResourceByOwner(worker.dispatchId)
    register('pty-unverifiable')
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(original)
  })

  it('does not change another execution host with the same pane and folder', () => {
    const worker = seedWorker(SSH_HOST)
    const original = db.getWorkerTerminalResourceByOwner(worker.dispatchId)
    register('pty-resumed', 'inc-resumed')
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(original)
  })

  it('does not change an active Dispatch resource', () => {
    const worker = seedWorker(LOCAL_HOST, false)
    const original = db.getWorkerTerminalResourceByOwner(worker.dispatchId)
    register('pty-resumed', 'inc-resumed')
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toEqual(original)
  })
})
