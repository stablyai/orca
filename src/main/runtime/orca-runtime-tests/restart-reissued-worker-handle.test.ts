// A restarted runtime can reissue a surviving worker PTY's handle; the worker still reports with its env handle.
// The env is consistency evidence, not caller authentication; incarnation match is record continuity, not liveness.
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { createOrchestrationRpcHarness } from '../rpc/methods/orchestration/rpc-test-harness'
import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'

const TAB = '44444444-4444-4444-8444-444444444444'
const PTY = `${TEST_WORKTREE_ID}@@restored1`
const EXPORTED_HANDLE = 'term_exported-before-restart'
const PANE = `${TAB}:${HEADLESS_LEAF_ID}`
const INCARNATION_ID = 'inc-restored'
const HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

/** Restart with the worker PTY alive in the daemon; the renderer graph lands before inventory adoption. */
async function restartWithSurvivingWorker(processIncarnationId = INCARNATION_ID) {
  const session = {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: TEST_WORKTREE_ID,
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: TAB,
          ptyId: PTY,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { [TAB]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY }) },
    // The worker started shortly before the restart, before its pane incarnation was persisted.
    terminalPtyIncarnationsByPaneKey: {}
  }
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: 'restart',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ spec: 'long worker task', runId: run.id })
  const dispatch = createRootDispatch(
    db,
    task.id,
    EXPORTED_HANDLE,
    PANE,
    undefined,
    `${PTY}:${INCARNATION_ID}`
  )
  db.db
    .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
    .run(HOST_SCOPE, dispatch.id)

  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(withDurableRuntimeStore(runtimeStore))
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      {
        id: PTY,
        incarnationId: processIncarnationId,
        terminalHandle: EXPORTED_HANDLE,
        title: 'claude',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        wslDistro: null
      }
    ]
  })
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB,
        worktreeId: TEST_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB,
        worktreeId: TEST_WORKTREE_ID,
        leafId: HEADLESS_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY
      }
    ]
  })
  await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  return { runtime, db, taskId: task.id, dispatchId: dispatch.id }
}

async function sendWorkerDone(
  runtime: OrcaRuntimeService,
  taskId: string,
  dispatchId: string
): Promise<unknown> {
  const method = createOrchestrationRpcHarness().findMethod('orchestration.send')
  const params = method.params?.parse({
    from: EXPORTED_HANDLE,
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
  })
  return await method.handler(params, {
    runtime,
    // What the worker's CLI reads from the env its PTY was launched with.
    orchestrationCompatibilityEvidence: {
      terminalHandle: EXPORTED_HANDLE,
      paneKey: PANE,
      launchToken: 'launch-token'
    }
  })
}

describe('worker_done after a restart reissues the surviving worker PTY handle', () => {
  it('strands the exported handle when the graph lands before inventory adoption', async () => {
    const { runtime } = await restartWithSurvivingWorker()

    expect(runtime.getTerminalPaneKey(EXPORTED_HANDLE)).toBeNull()
    expect(runtime.getTerminalHandleForPaneKey(PANE)).not.toBe(EXPORTED_HANDLE)
  })

  it('settles worker_done when the pane still records the Dispatch incarnation', async () => {
    const { runtime, db, taskId, dispatchId } = await restartWithSurvivingWorker()

    const result = await sendWorkerDone(runtime, taskId, dispatchId)

    expect(result).not.toMatchObject({ lifecycle: { action: 'rejected' } })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getTask(taskId)?.status).toBe('completed')
  })

  it('refuses worker_done when the pane now records a replacement incarnation', async () => {
    const { runtime, db, taskId, dispatchId } = await restartWithSurvivingWorker('inc-replacement')

    const result = await sendWorkerDone(runtime, taskId, dispatchId)

    expect(result).toMatchObject({
      lifecycle: { action: 'rejected', code: 'worker_identity_changed' }
    })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})
