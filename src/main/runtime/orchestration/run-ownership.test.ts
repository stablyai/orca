import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { getRunAuthority, getRunHandover } from './db/runs/run-authority-store'
import { issueRunHandover } from './db/runs/run-handover'
import type { RunCallerKey } from './db/runs/run-actor'

function caller(name: string): RunCallerKey {
  return {
    terminalHandle: name,
    paneKey: `pane-${name}`,
    orcaSessionId: null,
    processIncarnation: `process-${name}`
  }
}

describe('Run ownership', () => {
  let db: OrchestrationDb
  let closed = false
  afterEach(() => {
    if (!closed) {
      db?.close()
    }
    closed = false
  })

  function create(key: RunCallerKey) {
    return db.createRun({
      objective: 'coordinate',
      coordinatorHandle: key.terminalHandle,
      coordinatorPaneKey: key.paneKey,
      coordinatorOrcaSessionId: key.orcaSessionId,
      processIncarnation: key.processIncarnation
    })
  }
  function bind(runId: string, key: RunCallerKey, liveLabel: string | null = null) {
    return db.bindRun({
      runId,
      coordinatorHandle: key.terminalHandle,
      coordinatorPaneKey: key.paneKey,
      coordinatorOrcaSessionId: key.orcaSessionId,
      processIncarnation: key.processIncarnation,
      probed: { consumerGeneration: db.getRun(runId)?.consumer_generation ?? -1, liveLabel }
    })
  }
  function worker(runId: string, key: RunCallerKey) {
    const task = db.createTask({ runId, spec: 'work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      key.terminalHandle ?? '',
      key.paneKey ?? undefined,
      undefined,
      key.processIncarnation ?? undefined
    )
    return { task, dispatch }
  }

  it('records origin and lets a replacement inherit its Task’s child without freeing foreign Runs', () => {
    db = new OrchestrationDb(':memory:')
    const parent = create(caller('parent'))
    const original = caller('original')
    const { task, dispatch } = worker(parent.id, original)
    const child = create(original)
    expect(getRunAuthority(db, child.id)).toMatchObject({
      creating_dispatch_id: dispatch.id,
      creating_task_id: task.id,
      parent_run_id: parent.id,
      owner_task_id: task.id
    })
    const foreign = create(caller('foreign'))
    const before = db.getRun(child.id)
    expect(() => bind(foreign.id, original)).toThrow('not owned by your Task')
    expect(() => bind(parent.id, original)).toThrow('own Run or an ancestor')
    expect(db.getRun(child.id)).toEqual(before)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(dispatch.id)
    db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const replacement = caller('replacement')
    createRootDispatch(
      db,
      task.id,
      'replacement',
      replacement.paneKey ?? undefined,
      undefined,
      replacement.processIncarnation ?? undefined
    )
    expect(bind(child.id, replacement, 'the predecessor')).toMatchObject({
      coordinator_handle: 'replacement'
    })
    db.db
      .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
      .run(dispatch.id)
    expect(() => bind(child.id, original)).toThrow('replaced')
    const recovered = caller('recovered')
    bind(child.id, recovered)
    expect(() => bind(child.id, replacement, 'the user’s chat')).toThrow('still open')
    expect(getRunAuthority(db, child.id)?.owner_task_id).toBe(task.id)
  })

  it('hands ownership to a Task after the last coordinator moves on, atomically with the receipt', () => {
    db = new OrchestrationDb(':memory:')
    const issuer = caller('issuer')
    const run = create(issuer)
    const parent = create(caller('parent'))
    const target = caller('target')
    const { task } = worker(parent.id, target)
    const origin = getRunAuthority(db, run.id)
    issueRunHandover(db, { runId: run.id, caller: issuer, target: { taskId: task.id } })
    create(issuer)
    expect(getRunHandover(db, run.id)?.target_task_id).toBe(task.id)
    bind(run.id, issuer)
    expect(getRunHandover(db, run.id)).toBeDefined()
    db.beginMutationReceipt({
      callerFingerprint: 'test',
      requestId: 'accept',
      method: 'orchestration.runUse',
      payloadHash: 'input'
    })
    db.bindRun({
      runId: run.id,
      coordinatorHandle: target.terminalHandle,
      coordinatorPaneKey: target.paneKey,
      processIncarnation: target.processIncarnation,
      probed: {
        consumerGeneration: db.getRun(run.id)?.consumer_generation ?? -1,
        liveLabel: 'the issuer'
      },
      recordReceipt: (result) =>
        db.completeMutationReceipt({
          callerFingerprint: 'test',
          requestId: 'accept',
          method: 'orchestration.runUse',
          payloadHash: 'input',
          receipt: JSON.stringify(result)
        })
    })
    expect(db.getMutationReceipt('test', 'accept')?.state).toBe('completed')
    expect(getRunHandover(db, run.id)).toBeUndefined()
    expect(getRunAuthority(db, run.id)).toMatchObject({
      creating_dispatch_id: origin?.creating_dispatch_id,
      owner_task_id: task.id
    })
    expect(() =>
      issueRunHandover(db, { runId: run.id, caller: issuer, target: { taskId: task.id } })
    ).toThrow('current or last')
    create(target)
    issueRunHandover(db, { runId: run.id, caller: target, target: { caller: issuer } })
    expect(getRunHandover(db, run.id)).toBeDefined()
  })

  it('caller hand-over authorizes only that exact process, never Task-wide onward ownership', () => {
    db = new OrchestrationDb(':memory:')
    const issuer = caller('issuer')
    const run = create(issuer)
    const parent = create(caller('parent'))
    const target = caller('target')
    worker(parent.id, target)
    issueRunHandover(db, { runId: run.id, caller: issuer, target: { caller: target } })
    bind(run.id, target, 'the issuer')
    const accepted = db.getRun(run.id)
    bind(run.id, target)
    expect(db.getRun(run.id)).toEqual(accepted)
    expect(getRunAuthority(db, run.id)?.owner_task_id).toBeNull()
    expect(() =>
      issueRunHandover(db, { runId: run.id, caller: target, target: { caller: issuer } })
    ).toThrow('owned by its current Task')
    create(target)
    expect(() => bind(run.id, target)).toThrow('not owned by your Task')
    expect(() => bind(run.id, { ...target, processIncarnation: 'a different process' })).toThrow(
      'no longer matches'
    )
  })

  it('bounds grant lifetime and rolls back every effect when acceptance or its receipt fails', () => {
    db = new OrchestrationDb(':memory:')
    const issuer = caller('issuer')
    const run = create(issuer)
    const parent = create(caller('parent'))
    const target = caller('target')
    const { task } = worker(parent.id, target)
    const targetRun = create(target)
    issueRunHandover(db, { runId: run.id, caller: issuer, target: { taskId: task.id } })
    const before = db.getRun(run.id)
    expect(() =>
      db.bindRun({
        runId: run.id,
        coordinatorHandle: target.terminalHandle,
        coordinatorPaneKey: target.paneKey,
        processIncarnation: target.processIncarnation,
        recordReceipt: () => {
          throw new Error('receipt failed')
        }
      })
    ).toThrow('receipt failed')
    expect(db.getRun(run.id)).toEqual(before)
    expect(db.getRun(targetRun.id)?.coordinator_handle).toBe('target')
    expect(getRunHandover(db, run.id)).toBeDefined()
    db.db
      .prepare('UPDATE run_handovers SET expires_at = ? WHERE run_id = ?')
      .run(Date.now() - 1, run.id)
    expect(() => bind(run.id, target)).toThrow('not owned by your Task')
    issueRunHandover(db, { runId: run.id, caller: issuer, target: { taskId: task.id } })
    bind(run.id, caller('different'))
    expect(getRunHandover(db, run.id)).toBeUndefined()
  })

  it('rejects self/cyclic transfer and ambiguity before any creation or seat mutation', () => {
    db = new OrchestrationDb(':memory:')
    const root = caller('root')
    const parent = create(root)
    const target = caller('target')
    const { task, dispatch } = worker(parent.id, target)
    expect(() =>
      issueRunHandover(db, { runId: parent.id, caller: root, target: { taskId: task.id } })
    ).toThrow('own Run or an ancestor')
    const child = create(target)
    const nested = worker(child.id, caller('nested'))
    expect(() =>
      issueRunHandover(db, { runId: child.id, caller: target, target: { taskId: nested.task.id } })
    ).toThrow('own Run or an ancestor')
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
      .run(target.paneKey, nested.dispatch.id)
    const before = db.getRun(child.id)
    expect(() => create(target)).toThrow('several active')
    expect(db.getRun(child.id)).toEqual(before)
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
      .run('nested', nested.dispatch.id)
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET creator_orca_session_id = ?, assignee_orca_session_id = ?, creator_pane_key = ?, assignee_pane_key = ? WHERE id = ?'
      )
      .run(
        '85274790-6398-49f8-b9ff-1f9d2ee1b5ea',
        '85274790-6398-49f8-b9ff-1f9d2ee1b5ea',
        'different',
        target.paneKey,
        dispatch.id
      )
    expect(getRunAuthority(db, create(target).id)?.creating_dispatch_id).toBeNull()
  })

  it('retains origin through Task reset and leaves message reset outside ownership', () => {
    db = new OrchestrationDb(':memory:')
    const issuer = caller('issuer')
    const run = create(issuer)
    const parent = create(caller('parent'))
    const target = caller('target')
    const { task } = worker(parent.id, target)
    const child = create(target)
    issueRunHandover(db, { runId: run.id, caller: issuer, target: { taskId: task.id } })
    const origin = getRunAuthority(db, child.id)
    db.resetMessages()
    expect(getRunHandover(db, run.id)).toBeDefined()
    db.resetTasks()
    expect(getRunAuthority(db, child.id)).toEqual(origin)
    expect(getRunHandover(db, run.id)).toBeUndefined()
    db.resetAll()
    expect(getRunAuthority(db, child.id)).toBeUndefined()
  })

  it('keeps remote unchanged confirmation effect-free and requires a fresh exact grant after leaving', () => {
    db = new OrchestrationDb(':memory:')
    const remote = caller('remote')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      runId: 'run_remote_home',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'attach',
        payloadHash: 'input'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote',
      paneKey: remote.paneKey ?? '',
      processIncarnation: remote.processIncarnation ?? '',
      worktreeId: 'folder',
      terminalHandle: 'remote',
      setupState: 'ready',
      effects: []
    })
    const child = create(remote)
    const original = getRunAuthority(db, child.id)
    expect(original).toMatchObject({
      creating_home_peer: 'peer',
      creating_task_id: 'task_remote',
      parent_run_id: 'run_remote_home'
    })
    const before = db.getRun(child.id)
    bind(child.id, remote)
    expect(db.getRun(child.id)).toEqual(before)
    expect(getRunAuthority(db, child.id)).toEqual(original)
    expect(() =>
      issueRunHandover(db, {
        runId: child.id,
        caller: remote,
        target: { caller: caller('another') }
      })
    ).toThrow('remote worker')
    create(remote)
    expect(() => bind(child.id, remote)).toThrow('explicit hand-over')
    const recovery = caller('recovery')
    bind(child.id, recovery)
    issueRunHandover(db, { runId: child.id, caller: recovery, target: { caller: remote } })
    bind(child.id, remote, 'the recovery coordinator')
    expect(getRunAuthority(db, child.id)?.owner_task_id).toBeNull()
    expect(getRunHandover(db, child.id)).toBeUndefined()
    const next = { ...remote, processIncarnation: 'next-process' }
    db.db
      .prepare(
        'UPDATE remote_dispatch_attachments SET process_incarnation = ? WHERE dispatch_id = ?'
      )
      .run(next.processIncarnation, 'ctx_remote')
    expect(() => bind(child.id, next)).toThrow('explicit hand-over')
    const local = caller('local')
    bind('run_remote_home', local)
    const owner = caller('local-owner')
    const { task } = worker('run_remote_home', owner)
    bind(child.id, recovery)
    issueRunHandover(db, { runId: child.id, caller: recovery, target: { taskId: task.id } })
    bind(child.id, owner)
    const nested = db.createTask({ runId: child.id, spec: 'nested local work' })
    expect(() =>
      issueRunHandover(db, {
        runId: 'run_remote_home',
        caller: local,
        target: { taskId: nested.id }
      })
    ).toThrow('own Run or an ancestor')
  })

  it('migrates old occupied seats without inventing Task ownership or process proof', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-ownership-migration-'))
    const path = join(directory, 'orchestration.db')
    try {
      db = new OrchestrationDb(path)
      const key = caller('old-coordinator')
      const run = create(key)
      db.db.exec(`DROP TRIGGER trg_run_authority_insert; DROP TRIGGER trg_run_authority_update;
        DROP TRIGGER trg_run_authority_delete; DROP TABLE run_handovers; DROP TABLE run_authority;
        PRAGMA user_version = 43;`)
      db.close()
      db = new OrchestrationDb(path)
      expect(getRunAuthority(db, run.id)).toMatchObject({
        creating_dispatch_id: null,
        owner_task_id: null,
        last_handle: key.terminalHandle,
        last_process_incarnation: null
      })
      const parent = create(caller('parent'))
      const foreign = caller('foreign')
      worker(parent.id, foreign)
      expect(() => bind(run.id, foreign)).toThrow('not owned by your Task')
      expect(bind(run.id, key)).toMatchObject({ coordinator_handle: key.terminalHandle })
    } finally {
      db.close()
      closed = true
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
