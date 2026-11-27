import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { OrchestrationDb } from '../orchestration-db'
import { openRemoteRunLink } from '../remote-owned/remote-run-links'
import { recordRemoteStart, reserveRemotePlacement } from '../remote-owned/remote-placements'
import { recordRemoteDispatchState } from '../remote-owned/remote-dispatch-records'
import { readConnectorWorkerCandidates } from './connector-worker-candidates'
import { remoteConnectorActivity } from '../../federation/remote-owned/remote-connector-activity'

it('keeps only the recorded connector creator waiting through remote start, restart and lost contact until settlement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-remote-wait-'))
  let db = new OrchestrationDb(join(dir, 'orchestration.db'))
  try {
    const session = createOrcaSessionId(() => '11111111-1111-4111-8111-111111111111')
    const other = createOrcaSessionId(() => '22222222-2222-4222-8222-222222222222')
    const run = db.createRun({
      objective: 'remote wait',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const link = openRemoteRunLink(db, run.id, {
      environmentId: 'env_server',
      name: 'Server',
      peerFingerprint: 'fp_server',
      homePeerFingerprint: 'fp_home',
      pairingRevision: 1
    })
    for (const [taskId, creator, turnSource] of [
      ['task_wait', session, 'connector'],
      ['task_other', other, 'connector'],
      ['task_direct', session, undefined]
    ] as const) {
      reserveRemotePlacement(db, {
        link,
        taskId,
        requestKey: taskId,
        create: { spec: 'wait' },
        creator: { kind: 'session', orcaSessionId: creator, turnSource }
      })
    }
    const read = () => readConnectorWorkerCandidates(db, [session, session], 1000).remote
    expect(read()).toHaveLength(1)
    expect(remoteConnectorActivity(read()[0], undefined).state).toBe('unverifiable')
    recordRemoteStart(db, {
      conversationId: link.conversation_id,
      taskId: 'task_wait',
      dispatchId: 'ctx_wait',
      requestKey: 'task_wait'
    })
    recordRemoteDispatchState(db, 'ctx_wait', {
      status: 'dispatched',
      worker_state: 'running',
      last_failure: null,
      agent: 'codex'
    })
    db.close()
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    expect(read()).toHaveLength(1)
    expect(read()[0].sessionId).toBe(session)
    expect(remoteConnectorActivity(read()[0], { answeredAt: 1000 }).state).toBe('working')
    expect(
      remoteConnectorActivity(read()[0], { answeredAt: 1000, unreachableSince: 1100 }).state
    ).toBe('unverifiable')
    db.db
      .prepare("UPDATE remote_run_links SET state = 'closed' WHERE conversation_id = ?")
      .run(link.conversation_id)
    expect(remoteConnectorActivity(read()[0], { answeredAt: 1200 }).state).toBe('unverifiable')
    for (const worker_state of ['succeeded', 'failed', 'stopped', 'abandoned']) {
      recordRemoteDispatchState(db, 'ctx_wait', {
        status: 'dispatched',
        worker_state,
        last_failure: null,
        agent: 'codex'
      })
      expect(read()).toEqual([])
    }
    recordRemoteDispatchState(db, 'ctx_wait', {
      status: 'dispatched',
      worker_state: 'running',
      last_failure: null,
      agent: 'codex'
    })
    db.db
      .prepare('UPDATE remote_dispatches SET task_settled_here = 2 WHERE dispatch_id = ?')
      .run('ctx_wait')
    expect(read()).toEqual([])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
