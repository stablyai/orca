// STA-4603 / STA-4536: an operator close, a clean finish and a crash must not
// leave the same record. Each case here was byte-identical before the fix.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import type { DispatchContextRow } from './orchestration/types'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-exit-provenance'
const HANDLE = 'term_exit_provenance'
const WORKTREE_ID = 'repo-audit::/tmp/audit'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createDb(): OrchestrationDb {
  const directory = mkdtempSync(join(tmpdir(), 'exit-provenance-'))
  directories.push(directory)
  return new OrchestrationDb(join(directory, 'orchestration.db'))
}

function createRuntime(db: OrchestrationDb): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: 'audit-incarnation'
  })
  runtime.registerPreAllocatedHandleForPty(PTY_ID, HANDLE)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
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
  return runtime
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
  return { ...db.createDispatchContext(task.id, HANDLE, PANE_KEY), runId: run.id }
}

/** Where a lightweight Run's coordinator actually reads its mail (STA-4604). */
function escalations(db: OrchestrationDb, runId: string) {
  return db.getUnreadMessages(`run:${runId}`, ['escalation'])
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
  it('separates a deliberate close from a crash and from a clean finish', () => {
    const closedDb = createDb()
    const closed = createRuntime(closedDb)
    const closedCtx = dispatchOnHandle(closedDb, 'operator close')
    closed.markPtyStopRequested(PTY_ID)
    closed.onPtyExit(PTY_ID, 0)

    const crashDb = createDb()
    const crashed = createRuntime(crashDb)
    const crashCtx = dispatchOnHandle(crashDb, 'sigkill crash')
    crashed.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })

    const cleanDb = createDb()
    const clean = createRuntime(cleanDb)
    const cleanCtx = dispatchOnHandle(cleanDb, 'clean finish')
    clean.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'exited', exitCode: 0 } })

    expect(observe(closedDb, closedCtx.id)).toEqual({
      status: 'failed',
      last_failure: 'Terminal closed by operator request',
      termination_reason: 'operator_close'
    })
    expect(observe(crashDb, crashCtx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process killed by signal 9',
      termination_reason: 'signaled'
    })
    expect(observe(cleanDb, cleanCtx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process exited with code 0',
      termination_reason: 'exited'
    })
  })

  it('says unknown rather than inventing a status the host never reported', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    const ctx = dispatchOnHandle(db, 'macOS login wrapper')
    runtime.onPtyExit(PTY_ID, 0, undefined, {
      cause: { kind: 'unknown', reason: 'host_status_unavailable' }
    })
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process ended; this host cannot report why',
      termination_reason: 'unknown'
    })
  })

  it('does not read a bare code from an older daemon or an SSH relay as a clean finish', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    const ctx = dispatchOnHandle(db, 'exit delivered without a cause')
    // No `cause`: the reporter forwards a number and nothing else. Its 0 may be
    // a SIGKILL, so the record must not claim the agent finished.
    runtime.onPtyExit(PTY_ID, 0)
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process ended; the reporting host did not say why',
      termination_reason: 'unknown'
    })
  })

  it('settles the dispatch when the whole tab is closed before the exit lands', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    const ctx = dispatchOnHandle(db, 'whole-tab operator close')
    runtime.markPtyStopRequested(PTY_ID)
    // The tab teardown drops the leaf from the renderer graph first; the exit
    // used to find no leaf and leave the row reading 'dispatched' forever.
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyExit(PTY_ID, 0)
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Terminal closed by operator request',
      termination_reason: 'operator_close'
    })
  })

  it('does not escalate a deliberate close, but still escalates a crash', () => {
    const closedDb = createDb()
    const closed = createRuntime(closedDb)
    const closedCtx = dispatchOnHandle(closedDb, 'no escalation on close')
    closed.markPtyStopRequested(PTY_ID)
    closed.onPtyExit(PTY_ID, 0)
    // Assert the dispatch actually settled first: an empty inbox also happens
    // when nothing was settled at all, which would make this vacuous.
    expect(observe(closedDb, closedCtx.id).termination_reason).toBe('operator_close')
    expect(escalations(closedDb, closedCtx.runId)).toHaveLength(0)

    const crashDb = createDb()
    const crashed = createRuntime(crashDb)
    const crashCtx = dispatchOnHandle(crashDb, 'escalate on crash')
    crashed.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })
    expect(escalations(crashDb, crashCtx.runId)).toHaveLength(1)
  })

  it('does not carry an unconsumed stop intent across a same-id respawn', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    // The operator asked for a stop, but the stop never produced an exit — the
    // process outlived it. A respawn then reuses the same session id.
    runtime.markPtyStopRequested(PTY_ID)
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    expect(runtime.isPtyStopRequested(PTY_ID)).toBe(false)

    const ctx = dispatchOnHandle(db, 'crash after respawn')
    runtime.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })
    // The replacement's crash must not inherit the old close's provenance.
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process killed by signal 9',
      termination_reason: 'signaled'
    })
  })

  it('does not file an unconfirmed stop as a completed operator close', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    const ctx = dispatchOnHandle(db, 'stop requested but never confirmed')
    runtime.markPtyStopRequested(PTY_ID)
    // The stop paths pass -1 when they asked a process to die and never saw it.
    // The process may still be running against a revoked dispatch.
    runtime.onPtyExit(PTY_ID, -1)
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process stop was requested but never confirmed',
      termination_reason: 'unknown'
    })
    // ...and it must still wake the coordinator, unlike a clean close.
    expect(escalations(db, ctx.runId)).toHaveLength(1)
  })

  it('treats a reported completion as authoritative and makes the later exit a no-op', () => {
    const db = createDb()
    const runtime = createRuntime(db)
    const ctx = dispatchOnHandle(db, 'worker_done then exit')
    const settlement = db.settleWorkerReport({
      taskId: ctx.task_id,
      dispatchId: ctx.id,
      outcome: 'succeeded',
      result: JSON.stringify({ provenance: 'worker_report', outcome: 'succeeded' })
    })
    expect(settlement.action).toBe('settled')
    runtime.onPtyExit(PTY_ID, 0)
    expect(observe(db, ctx.id)).toMatchObject({ status: 'completed', last_failure: null })
  })

  it('marks the intent from the real close path, not just from the helper', async () => {
    const db = createDb()
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    // Model the shipping controller: `orca terminal close` reaches stopAndWait,
    // which verifies the stop and then reports it with a synthetic code 0 --
    // a number indistinguishable from a clean agent finish.
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
    runtime.syncWindowGraph(1, {
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

  it('publishes the cause on the terminal record a coordinator polls', async () => {
    const db = createDb()
    const runtime = createRuntime(db)
    dispatchOnHandle(db, 'terminal summary shape')
    runtime.markPtyStopRequested(PTY_ID)
    runtime.onPtyExit(PTY_ID, 0)
    const summary = await runtime.showTerminal(HANDLE)
    expect(summary.connected).toBe(false)
    expect(summary.exitCause).toEqual({ kind: 'operator_close' })
  })

  it('leaves no exitCause on a terminal that is still running', async () => {
    const db = createDb()
    const runtime = createRuntime(db)
    dispatchOnHandle(db, 'still running')
    const summary = await runtime.showTerminal(HANDLE)
    expect(summary.exitCause).toBeUndefined()
  })
})
