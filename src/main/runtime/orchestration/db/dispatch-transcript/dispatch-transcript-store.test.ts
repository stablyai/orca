import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { DispatchTranscriptStore } from './dispatch-transcript-store'
import type { DispatchTranscriptTerminalIdentity } from './dispatch-transcript-types'

const terminal: DispatchTranscriptTerminalIdentity = {
  executionHostId: 'ssh:build-host',
  workspaceKey: 'folder:remote-project',
  terminalHandle: 'term_settled',
  paneKey: 'tab_1:leaf_1',
  ptyIncarnation: 'pty:exact',
  processRootId: 'pid:exact'
}

const launchProfile = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  permissionMode: 'yolo',
  routeRef: null
}

describe('Dispatch transcript store', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('preserves exact Dispatch segments across settled terminal transfer and restart', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-dispatch-transcript-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const predecessor = createSettledPredecessor(db)
    let store = new DispatchTranscriptStore(db)
    store.startSegment({
      dispatchId: 'ctx_old',
      leaseId: predecessor.id,
      runId: 'run_1',
      taskId: 'task_old',
      attemptId: 'attempt_old',
      startCursor: 0,
      ...terminal
    })
    store.appendEntries({
      dispatchId: 'ctx_old',
      terminal,
      entries: [
        { cursor: 0, payload: 'predecessor one' },
        { cursor: 1, payload: 'predecessor two' }
      ]
    })
    const leaseTransfer = db.transferMaestroWorkerTerminalLease({
      requestId: 'lease-transfer:1',
      predecessorLeaseId: predecessor.id,
      successorRequestId: 'worker:ctx_new',
      kind: 'settled_resource_reuse',
      successorDispatchId: 'ctx_new',
      runId: 'run_1',
      taskId: 'task_new',
      attemptId: 'attempt_new',
      terminalHandle: terminal.terminalHandle,
      paneKey: terminal.paneKey,
      ptyIncarnation: terminal.ptyIncarnation,
      processRootId: terminal.processRootId,
      executionHostId: terminal.executionHostId,
      workspaceKey: terminal.workspaceKey,
      hostScope: 'ssh:build-host',
      predecessorOwnerPrincipal: 'dispatch:ctx_old',
      successorOwnerPrincipal: 'dispatch:ctx_new',
      coordinatorGeneration: null,
      retentionPolicy: 'auto_release',
      title: 'task_new · worker · Codex',
      launchProfile,
      spawnedBy: 'coordinator:g1'
    })
    const transcriptTransfer = {
      requestId: 'transcript-transfer:1',
      leaseTransferRequestId: leaseTransfer.requestId,
      predecessorDispatchId: 'ctx_old',
      predecessorLeaseId: predecessor.id,
      successorDispatchId: 'ctx_new',
      successorLeaseId: leaseTransfer.successorLeaseId,
      successorRunId: 'run_1',
      successorTaskId: 'task_new',
      successorAttemptId: 'attempt_new',
      transferCursor: 2,
      ...terminal
    }

    expect(() =>
      store.startSegment({
        dispatchId: 'ctx_new',
        leaseId: leaseTransfer.successorLeaseId,
        runId: 'run_1',
        taskId: 'task_new',
        attemptId: 'attempt_new',
        startCursor: 2,
        ...terminal
      })
    ).toThrow(/explicit transfer receipt/)
    const receipt = store.transferSegment(transcriptTransfer)
    expect(store.transferSegment(transcriptTransfer)).toEqual(receipt)
    expect(() =>
      store.transferSegment({ ...transcriptTransfer, requestId: 'transcript-transfer:competing' })
    ).toThrow()
    store.appendEntries({
      dispatchId: 'ctx_new',
      terminal,
      entries: [
        { cursor: 2, payload: 'successor one' },
        { cursor: 3, payload: 'successor two' },
        { cursor: 4, payload: 'successor three' }
      ]
    })

    const current = store.read({ dispatchId: 'ctx_new', limit: 2 })
    expect(current.entries.map((entry) => entry.payload)).toEqual([
      'successor one',
      'successor two'
    ])
    expect(current.continuation).toMatchObject({ hasMore: true, returnedCount: 2 })
    expect(
      store
        .read({ dispatchId: 'ctx_new', cursor: current.continuation.cursor, limit: 2 })
        .entries.map((entry) => entry.payload)
    ).toEqual(['successor three'])
    expect(
      store
        .read({
          dispatchId: 'ctx_new',
          selector: { kind: 'predecessor', dispatchId: 'ctx_old' }
        })
        .entries.map((entry) => entry.payload)
    ).toEqual(['predecessor one', 'predecessor two'])
    const history = store.read({
      dispatchId: 'ctx_new',
      selector: { kind: 'all' },
      limit: 3
    })
    expect(history.entries.map((entry) => entry.payload)).toEqual([
      'predecessor one',
      'predecessor two',
      'successor one'
    ])
    expect(history.continuation.hasMore).toBe(true)
    expect(
      store
        .read({
          dispatchId: 'ctx_new',
          selector: { kind: 'all' },
          cursor: history.continuation.cursor,
          limit: 3
        })
        .entries.map((entry) => entry.payload)
    ).toEqual(['successor two', 'successor three'])
    store.closeSegment({ dispatchId: 'ctx_new', endCursor: 5, terminal })

    db.close()
    db = new OrchestrationDb(dbPath)
    store = new DispatchTranscriptStore(db)
    expect(store.getSegment('ctx_old')).toMatchObject({ startCursor: 0, endCursor: 2 })
    expect(store.getSegment('ctx_new')).toMatchObject({ startCursor: 2, endCursor: 5 })
    expect(store.getTransferReceipt(receipt.requestId)).toEqual(receipt)
    expect(store.read({ dispatchId: 'ctx_new' }).entries.map((entry) => entry.payload)).toEqual([
      'successor one',
      'successor two',
      'successor three'
    ])
  })
})

function createSettledPredecessor(db: OrchestrationDb) {
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
        process_incarnation, host_scope, ownership_state, release_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owned', 'not_requested')`
    )
    .run(
      'wtr_settled',
      'ctx_old',
      'ctx_old',
      terminal.terminalHandle,
      terminal.paneKey,
      terminal.ptyIncarnation,
      'ssh:build-host'
    )
  db.db
    .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, 'succeeded')")
    .run('ctx_old')
  const lease = db.reserveMaestroTerminalLease({
    requestId: 'worker:ctx_old',
    executionHostId: terminal.executionHostId,
    workspaceKey: terminal.workspaceKey,
    runId: 'run_1',
    taskId: 'task_old',
    attemptId: 'attempt_old',
    role: 'worker',
    workerTerminalResourceId: 'wtr_settled',
    title: 'task_old · worker · Codex',
    launchProfile,
    spawnedBy: 'coordinator:g1',
    ownerPrincipal: 'dispatch:ctx_old',
    retentionPolicy: 'auto_release'
  })
  db.attachMaestroTerminalLease({
    leaseId: lease.id,
    terminalHandle: terminal.terminalHandle,
    tabId: 'tab_1',
    paneKey: terminal.paneKey,
    ptyIncarnation: terminal.ptyIncarnation,
    processRootId: terminal.processRootId,
    executionHostId: terminal.executionHostId,
    workspaceKey: terminal.workspaceKey,
    workerTerminalResourceId: 'wtr_settled'
  })
  db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
  db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'active' })
  db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'settled' })
  return lease
}
