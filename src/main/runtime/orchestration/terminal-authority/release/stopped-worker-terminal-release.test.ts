import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import { sweepStoppedWorkerTerminals } from './stopped-worker-terminal-release'

let db: OrchestrationDb | undefined
const INCARNATION = '0f6e2b8c-3c1d-4a5e-9b7f-2d4c6a8e0b13'

afterEach(() => {
  db?.close()
})

/** A stopped worker whose row an older build left owned and never requested. */
function leftOwnedStoppedWorker(d: OrchestrationDb, name: string): string {
  const task = d.createTask({ runId: 'run_legacy_local', spec: name })
  const started = d.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  d.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: `term_${name}`,
    paneKey: `tab_${name}:leaf_${name}`,
    processIncarnation: `pty-${name}:${INCARNATION}`,
    worktreeId: 'repo::worktree',
    setupState: 'not_applicable',
    terminalOwnership: 'created',
    effects: []
  })
  d.markWorkerDispatchReady(started.dispatch.id)
  d.beginWorkerStop(started.dispatch.id, 'runtime_test')
  d.settleWorkerStop(started.dispatch.id)
  d.db
    .prepare(
      `UPDATE worker_terminal_resources SET ownership_state = 'owned', release_state = 'not_requested',
         release_completed_at = NULL, updated_at = datetime('now', '-1 minute')
       WHERE owner_dispatch_id = ?`
    )
    .run(started.dispatch.id)
  return started.dispatch.id
}

function fakeRuntime(
  d: OrchestrationDb,
  verdicts: Record<string, 'live' | 'exited' | 'unverifiable'>
): WorkerTerminalReleaseRuntime {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these three members.
  return {
    getExistingOrchestrationDb: () => d,
    ensureStructuredAgentSessionHost: async () => undefined,
    inspectTerminalProcessIncarnationLiveness: async (incarnation: string) =>
      verdicts[incarnation] ?? 'unverifiable'
  } as unknown as WorkerTerminalReleaseRuntime
}

describe('sweepStoppedWorkerTerminals', () => {
  it('releases only rows whose process is proven exited', async () => {
    db = new OrchestrationDb(':memory:')
    const exited = leftOwnedStoppedWorker(db, 'exited')
    const live = leftOwnedStoppedWorker(db, 'live')
    const unknown = leftOwnedStoppedWorker(db, 'unknown')

    await sweepStoppedWorkerTerminals(
      fakeRuntime(db, {
        [`pty-exited:${INCARNATION}`]: 'exited',
        [`pty-live:${INCARNATION}`]: 'live'
      }),
      () => false
    )

    expect(db.getWorkerTerminalResourceByOwner(exited)?.release_state).toBe('released')
    expect(db.getWorkerTerminalResourceByOwner(live)?.release_state).toBe('not_requested')
    expect(db.getWorkerTerminalResourceByOwner(unknown)?.release_state).toBe('not_requested')
  })

  it('admits no work once its owner has stopped', async () => {
    db = new OrchestrationDb(':memory:')
    const exited = leftOwnedStoppedWorker(db, 'exited')

    await sweepStoppedWorkerTerminals(
      fakeRuntime(db, { [`pty-exited:${INCARNATION}`]: 'exited' }),
      () => true
    )

    expect(db.getWorkerTerminalResourceByOwner(exited)?.release_state).toBe('not_requested')
  })
})
