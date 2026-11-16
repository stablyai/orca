// STA-4603/STA-4536: distinguish operator close, clean finish and crash records.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../db/orchestration-db'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import type { DispatchContextRow } from '../db/orchestration-records'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const PTY_ID = 'pty-exit-provenance'
const HANDLE = 'term_exit_provenance'
const WORKTREE_ID = 'repo-audit::/tmp/audit'

const directories: string[] = []

class ExitProvenanceRuntime extends OrcaRuntimeService {
  exitEvidence() {
    const pty = this.ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('Missing test PTY')
    }
    return [pty, ...this.getLeavesForPty(PTY_ID)].map((record) => ({
      code: record.lastExitCode,
      cause: record.lastExitCause
    }))
  }
}

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

async function createRuntime(
  db: OrchestrationDb,
  incarnationId: string | null = 'audit-incarnation'
): Promise<ExitProvenanceRuntime> {
  const runtime = new ExitProvenanceRuntime(null)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...(incarnationId ? { incarnationId } : {})
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
  return {
    ...createRootDispatch(db, task.id, HANDLE, PANE_KEY),
    runId: run.id
  }
}

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
  it('settles the dispatch when the whole tab is closed before the exit lands', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
    const ctx = dispatchOnHandle(db, 'whole-tab operator close')
    runtime.markPtyStopRequested(PTY_ID)
    // Renderer teardown removes the leaf first; exit must still settle the dispatch.
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.onPtyExit(PTY_ID, 0)
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Terminal closed by operator request',
      termination_reason: 'operator_close'
    })
  })

  it('reports a person closing a running worker once as lost, with its last output', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
    const ctx = dispatchOnHandle(db, 'closed by a person')
    runtime.onPtyData(PTY_ID, 'Waiting for CI on the pull request\r\n', 1)
    runtime.markPtyStopRequested(PTY_ID)
    runtime.onPtyExit(PTY_ID, 0)
    // A repeated exit report must not repeat the alert.
    runtime.onPtyExit(PTY_ID, 0)
    expect(observe(db, ctx.id).termination_reason).toBe('operator_close')
    const mail = escalations(db, ctx.runId)
    expect(mail.map((message) => message.subject)).toEqual(['Worker lost without reporting'])
    expect(mail[0]?.body).toContain('is gone (it was closed in Orca)')
    expect(mail[0]?.body).toContain('Waiting for CI on the pull request')
    expect(mail[0]?.body).not.toContain('still open')
  })

  it('reports a crash once as an exit', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
    const ctx = dispatchOnHandle(db, 'escalate on crash')
    runtime.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })
    const mail = escalations(db, ctx.runId)
    expect(mail.map((message) => message.subject)).toEqual(['Worker exited without reporting'])
    expect(mail[0]?.body).toContain('exited (Agent process killed by signal 9)')
  })

  it('does not carry an unconsumed stop intent across a same-id respawn', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
    // An unobserved stop outlives its request; respawn reuses the session id.
    runtime.markPtyStopRequested(PTY_ID)
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, { value: 0, generation: 'reset' })
    expect(runtime.isPtyStopRequested(PTY_ID)).toBe(false)

    const ctx = dispatchOnHandle(db, 'crash after respawn')
    runtime.onPtyExit(PTY_ID, 0, undefined, { cause: { kind: 'signaled', signal: 9 } })
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process killed by signal 9',
      termination_reason: 'signaled'
    })
  })

  it('does not file an unconfirmed stop as a completed operator close', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
    const ctx = dispatchOnHandle(db, 'stop requested but never confirmed')
    runtime.markPtyStopRequested(PTY_ID)
    // -1 reports an unverified stop, so the process may still own a revoked dispatch.
    runtime.onPtyExit(PTY_ID, -1)
    expect(observe(db, ctx.id)).toEqual({
      status: 'failed',
      last_failure: 'Agent process stop was requested but never confirmed',
      termination_reason: 'unknown'
    })
    expect(escalations(db, ctx.runId)).toHaveLength(1)
  })

  it('treats a reported completion as authoritative and makes the later exit a no-op', async () => {
    const db = createDb()
    const runtime = await createRuntime(db)
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

  describe.each(['registration', 'spawn'] as const)('incarnation replacement via %s', (path) => {
    function announce(runtime: OrcaRuntimeService, incarnationId?: string): void {
      if (path === 'registration') {
        runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
          tabId: TAB_ID,
          leafId: LEAF_ID,
          incarnationId
        })
      } else {
        runtime.onPtySpawned(PTY_ID, incarnationId, { awaitsRegistration: false })
      }
    }

    it('retires an operator close and ignores a late predecessor exit', async () => {
      const runtime = await createRuntime(createDb())
      runtime.markPtyStopRequested(PTY_ID)
      await runtime.onPtyExit(PTY_ID, 0, 'audit-incarnation')
      expect((await runtime.showTerminal(HANDLE)).exitCause).toEqual({ kind: 'operator_close' })

      announce(runtime, 'replacement-incarnation')
      runtime.registerPreAllocatedHandleForPty(PTY_ID, 'term_replacement')
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
          {
            tabId: TAB_ID,
            worktreeId: WORKTREE_ID,
            leafId: LEAF_ID,
            paneRuntimeId: 1,
            ptyId: PTY_ID
          }
        ]
      })

      const summary = await runtime.showTerminal('term_replacement')
      expect(summary.connected).toBe(true)
      expect(summary.incarnationId).toBe('replacement-incarnation')
      expect(summary.exitCause).toBeUndefined()
      const clearedEvidence = { code: null, cause: null }
      expect(runtime.exitEvidence()).toEqual(
        ORCA_LAYOUT_OWNER_IS_MAIN ? [clearedEvidence] : [clearedEvidence, clearedEvidence]
      )
      await runtime.onPtyExit(PTY_ID, -1, 'audit-incarnation', {
        cause: { kind: 'unknown', reason: 'stop_unverified' }
      })
      expect((await runtime.showTerminal('term_replacement')).exitCause).toBeUndefined()

      await runtime.onPtyExit(PTY_ID, 7, 'replacement-incarnation', {
        cause: { kind: 'exited', exitCode: 7 }
      })
      expect((await runtime.showTerminal('term_replacement')).exitCause).toEqual({
        kind: 'exited',
        exitCode: 7
      })
    })
  })
})
