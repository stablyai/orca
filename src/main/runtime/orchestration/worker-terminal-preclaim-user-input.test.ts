import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

const PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REMINTED = 'tab_reminted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const IDENTITY = {
  paneKey: PANE,
  processIncarnation: 'runtime:pty:1',
  worktreeId: 'folder_workspace',
  hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
}

describe('user input before worker terminal ownership', () => {
  let db: OrchestrationDb
  let directory: string | undefined
  let sequence: number

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    sequence = 0
  })
  afterEach(() => {
    db.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  function worker(
    kind: 'local' | 'remote',
    ownership: 'created' | 'external' = 'created',
    paneKey = PANE
  ) {
    const terminalHandle = `term_worker_${++sequence}`
    const common = {
      ...IDENTITY,
      paneKey,
      terminalOwnership: ownership,
      effects: [],
      setupState: 'not_applicable'
    }
    if (kind === 'remote') {
      const dispatchId = `ctx_remote_${sequence}`
      db.createRemoteDispatchAttachment({
        dispatchId,
        taskId: `task_remote_${sequence}`,
        homePeerFingerprint: 'home_peer',
        protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
        runtimeEpoch: 'epoch_worker',
        mutationReceipt: {
          callerFingerprint: 'home_peer',
          requestId: `request_${sequence}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `hash_${sequence}`
        }
      })
      db.prepareRemoteAttachmentAuthority({ dispatchId, terminalHandle, ...common })
      db.markRemoteAttachmentReady(dispatchId)
      return { kind, dispatchId, taskId: `task_remote_${sequence}` }
    }
    const run = db.createRun({
      objective: 'bounded worker run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = db.createTask({ spec: 'bounded worker', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      ...common
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { kind, dispatchId: started.dispatch.id, taskId: task.id }
  }

  function settle(value: ReturnType<typeof worker>) {
    if (value.kind === 'remote') {
      db.recordRemoteAttachmentStage({
        dispatchId: value.dispatchId,
        state: 'succeeded',
        stage: 'worker_reported'
      })
    } else {
      db.settleWorkerReport({
        taskId: value.taskId,
        dispatchId: value.dispatchId,
        outcome: 'succeeded',
        result: 'done'
      })
    }
  }

  it.each(['local', 'remote'] as const)(
    'retains a newly claimed %s terminal after earlier input',
    (kind) => {
      expect(db.markWorkerTerminalUserOwned(PANE)).toBe(0)
      const value = worker(kind)
      settle(value)
      expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)).toMatchObject({
        ownership_state: 'user_owned',
        release_state: 'retained',
        retained_reason: 'user_takeover'
      })
      const release =
        kind === 'local'
          ? db.requestWorkerTerminalRelease(value.dispatchId)
          : db.requestRemoteAttachmentTerminalRelease(value.dispatchId)
      expect(release).toMatchObject({ disposition: 'retained', reason: 'user_takeover' })
    }
  )

  it('recognizes the same stable leaf after tab reminting', () => {
    db.markWorkerTerminalUserOwned(PANE)
    const value = worker('remote', 'created', REMINTED)
    expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)?.ownership_state).toBe(
      'user_owned'
    )
  })

  it('stores one identity hash without the pane credential and keeps the changed count precise', () => {
    expect(db.markWorkerTerminalUserOwned(PANE)).toBe(0)
    expect(db.markWorkerTerminalUserOwned(REMINTED)).toBe(0)
    const rows = db.db.prepare('SELECT * FROM worker_terminal_user_inputs').all()
    expect(rows).toEqual([
      { pane_identity: expect.stringMatching(/^[a-f0-9]{64}$/), first_input_at: expect.any(String) }
    ])
    expect(JSON.stringify(rows)).not.toContain('bbbbbbbb')

    const otherPane = 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const value = worker('local', 'created', otherPane)
    expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)?.ownership_state).toBe('owned')
    expect(db.markWorkerTerminalUserOwned(otherPane)).toBe(1)
    expect(db.markWorkerTerminalUserOwned(otherPane)).toBe(0)
  })

  it.each(['tab_legacy:1', 'unparseable-key'])(
    'retains an exact legacy key %s without aliasing another key',
    (paneKey) => {
      db.markWorkerTerminalUserOwned(paneKey)
      const same = worker('local', 'created', paneKey)
      expect(db.getWorkerTerminalResourceByOwner(same.dispatchId)?.ownership_state).toBe(
        'user_owned'
      )
      const other = worker('remote', 'created', `other_${paneKey}`)
      expect(db.getWorkerTerminalResourceByOwner(other.dispatchId)?.ownership_state).toBe('owned')
    }
  )

  it.each(['local', 'remote'] as const)(
    'preserves ordinary %s ownership without user input',
    (kind) => {
      const value = worker(kind)
      expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
    }
  )

  it.each(['local', 'remote'] as const)(
    'does not promote or reclassify an external %s terminal',
    (kind) => {
      db.markWorkerTerminalUserOwned(PANE)
      const value = worker(kind, 'external')
      expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)).toMatchObject({
        ownership_state: 'external',
        retained_reason: 'external_terminal'
      })
    }
  )

  it('preserves exact owned transfer when no input was observed', () => {
    const first = worker('local')
    settle(first)
    const resource = db.getWorkerTerminalResourceByOwner(first.dispatchId)!
    const next = worker('remote', 'external', REMINTED)
    expect(db.getWorkerTerminalResourceByOwner(next.dispatchId)).toMatchObject({
      id: resource.id,
      ownership_state: 'owned',
      origin_dispatch_id: first.dispatchId
    })
  })

  it('never transfers a stopped owner after input arrived during its committed stop', () => {
    const first = worker('local')
    db.beginWorkerStop(first.dispatchId, 'epoch_worker')
    expect(db.markWorkerTerminalUserOwned(PANE)).toBe(0)
    db.settleWorkerStop(first.dispatchId)
    const resource = db.getWorkerTerminalResourceByOwner(first.dispatchId)!
    const next = worker('remote', 'external', REMINTED)
    expect(db.getWorkerTerminalResourceByOwner(next.dispatchId)).toMatchObject({
      ownership_state: 'external'
    })
    expect(db.getWorkerTerminalResourceByOwner(first.dispatchId)?.id).toBe(resource.id)
  })

  it.each(['releasing', 'unknown'] as const)(
    'still refuses reuse over %s release despite later input',
    (state) => {
      const first = worker('local')
      settle(first)
      const resource = db.requestWorkerTerminalRelease(first.dispatchId).resource!
      db.commitWorkerTerminalArchiveForRelease({
        dispatchId: first.dispatchId,
        resourceId: resource.id,
        kind: 'terminal_tail',
        content: JSON.stringify({ lines: ['output'] }),
        archiveSource: 'terminal',
        archiveStatus: 'captured'
      })
      if (state === 'unknown') {
        db.markWorkerTerminalReleaseUnknown(resource.id, 'unverified stop')
      }
      expect(db.markWorkerTerminalUserOwned(PANE)).toBe(0)
      expect(() => worker('remote', 'external', REMINTED)).toThrow('release in progress')
      expect(db.getWorkerTerminalResource(resource.id)?.release_state).toBe(state)
    }
  )

  it('retains failed-start adoption after input before readiness failed', () => {
    const task = db.createTask({ spec: 'failed readiness' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskId: task.id,
      startOptions: {}
    })
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_readying',
      terminalHandle: 'term_failed'
    })
    db.markWorkerTerminalUserOwned(PANE)
    db.failWorkerStart(started.dispatch.id, 'agent_readiness', 'not ready', {
      adoptResidualTerminal: { terminalHandle: 'term_failed', ...IDENTITY }
    })
    expect(db.requestWorkerTerminalRelease(started.dispatch.id)).toMatchObject({
      disposition: 'retained',
      reason: 'user_takeover'
    })
  })

  it('keeps input across database reopen before ownership is recorded', () => {
    db.close()
    directory = mkdtempSync(join(tmpdir(), 'orca-preclaim-input-'))
    const filename = join(directory, 'orchestration.db')
    db = new OrchestrationDb(filename)
    db.markWorkerTerminalUserOwned(PANE)
    db.close()
    db = new OrchestrationDb(filename)
    const value = worker('local')
    expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)?.ownership_state).toBe(
      'user_owned'
    )
  })

  it('adds the latch to an existing schema without a version change, archive rebuild, or ownership backfill', () => {
    db.close()
    directory = mkdtempSync(join(tmpdir(), 'orca-preclaim-input-'))
    const filename = join(directory, 'orchestration.db')
    db = new OrchestrationDb(filename)
    const value = worker('local')
    const resource = db.getWorkerTerminalResourceByOwner(value.dispatchId)!
    db.storeWorkerTerminalArchive({
      dispatchId: value.dispatchId,
      resourceId: resource.id,
      kind: 'structured_journal',
      content: '{"version":1}'
    })
    const archiveTable = db.db
      .prepare("SELECT sql, rootpage FROM sqlite_master WHERE name = 'worker_terminal_archives'")
      .get()
    // Model a pre-latch schema-39 database, using only this disposable test database.
    db.db.exec('DROP TABLE worker_terminal_user_inputs')
    db.close()
    db = new OrchestrationDb(filename)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      db.db
        .prepare("SELECT sql, rootpage FROM sqlite_master WHERE name = 'worker_terminal_archives'")
        .get()
    ).toEqual(archiveTable)
    expect(db.getWorkerTerminalArchive(value.dispatchId)).toMatchObject({
      kind: 'structured_journal',
      content: '{"version":1}'
    })
    expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)).toEqual(resource)
    expect(db.db.prepare('SELECT * FROM worker_terminal_user_inputs').all()).toEqual([])
  })

  it.each(['resetTasks', 'resetAll'] as const)(
    'keeps input across %s because task reset does not retire panes',
    (reset) => {
      db.markWorkerTerminalUserOwned(PANE)
      db[reset]()
      const value = worker('local')
      expect(db.getWorkerTerminalResourceByOwner(value.dispatchId)?.ownership_state).toBe(
        'user_owned'
      )
    }
  )
})
