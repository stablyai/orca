// STA-4603/STA-4536: distinguish operator close, clean finish and crash records.
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import type { DispatchContextRow } from '../db/orchestration-records'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import '../../../../shared/workspace-layout/layout-owner-switch'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-exit-provenance'
const HANDLE = 'term_exit_provenance'
const WORKTREE_ID = 'repo-audit::/tmp/audit'

let openDb: OrchestrationDb | undefined

afterEach(() => {
  openDb?.close()
  openDb = undefined
})

function createDb(): OrchestrationDb {
  openDb = new OrchestrationDb(':memory:')
  return openDb
}

function dispatchOnHandle(
  db: OrchestrationDb,
  spec: string
): DispatchContextRow & { runId: string } {
  const run = db.createRun({
    objective: spec,
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
  })
  const task = db.createTask({ spec, runId: run.id })
  return {
    ...createRootDispatch(db, task.id, HANDLE, PANE_KEY),
    runId: run.id
  }
}

function observe(db: OrchestrationDb, ctxId: string) {
  const row = db.getDispatchContextById(ctxId)!
  return {
    status: row.status,
    last_failure: row.last_failure,
    termination_reason: row.termination_reason
  }
}

describe('STA-4603/STA-4536 exit provenance', () => {
  it('marks the intent from the real close path, not just from the helper', async () => {
    const db = createDb()
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    // stopAndWait reports verified user stops with synthetic 0, indistinguishable from finish by code alone.
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      stopAndWait: async (ptyId: string) => {
        runtime.onPtyExit(ptyId, 0)
        return true
      }
    })
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'audit-incarnation'
    })
    runtime.registerPreAllocatedHandleForPty(PTY_ID, HANDLE)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Agent',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
      ]
    })
    const ctx = dispatchOnHandle(db, 'close through the real path')

    await runtime.closeTerminal(HANDLE)

    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Terminal closed by operator request',
      termination_reason: 'operator_close'
    })
  })
})
