import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import '../../../../../orchestration/db/contract-constants'
import '../../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../../orchestration/db/dispatch-row-writer'
import '../../../../../orchestration/db/attempt-outcome-projection'
import { dispatchReportMailbox } from '../../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { reportFailedWorkerStart } from '../../../../../orchestration/workers/turn-stops/failed-worker-start-report'
import { settleRestartCutStart } from '../../../../../orchestration/workers/turn-stops/awaiting-worker-start-report'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { GitCommandTimeoutError } from '../../../../../../../shared/git/commands/git-command-timeout'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import { TerminalHostCapError } from '../../../../../../../shared/terminal/pty/lifecycle/terminal-host-cap-refusal'
import { readDispatchWorkers, type SessionWorkersRuntime } from '../session-workers-method'

const closedChats = vi.hoisted((): string[] => [])
vi.mock('../../../../../agent-session/lifecycle/structured-agent-session-close', () => ({
  closeStructuredAgentSessionChild: async (sessionId: string) => {
    closedChats.push(sessionId)
    return { stopped: true, closeAttempted: true }
  }
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each stub has every member the code under test calls.
const stub = <T>(members: Partial<T>): T => members as T

describe('a worker start cut before its agent ran', () => {
  let db: OrchestrationDb
  let runId: string
  afterEach(() => db?.close())

  function open(): void {
    db = new OrchestrationDb(':memory:')
    runId = db.createRun({
      objective: 'work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    }).id
  }

  function starting(
    federation?: Parameters<OrchestrationDb['createStartingWorkerDispatch']>[0]['federation']
  ) {
    const task = db.createTask({ runId, spec: 'work' })
    return db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      ...(federation ? { federation } : {})
    }).dispatch
  }

  function failStart(dispatchId: string, taskId: string, error: unknown) {
    const runtime = stub<OrcaRuntimeService>({
      notifyMessageArrived: () => {},
      reportUnconfirmedWorkerStart: async () => {}
    })
    return failWorkerStartWithReceipt({
      runtime,
      structuredSession: null,
      db,
      runId,
      taskId,
      dispatchId,
      failedStage: 'worktree_create',
      error,
      setup: stub({}),
      launch: stub({}),
      mode: stub({})
    })
  }

  const readRuntime = (): SessionWorkersRuntime =>
    stub<SessionWorkersRuntime>({
      getOrchestrationDb: () => db,
      getOrchestrationFleetAgentStatusSnapshot: () => [],
      ensureStructuredAgentSessionHost: async () => {},
      getAgentStatusSnapshotFn: () => [],
      resolveOrchestrationWorkerServer: () => {
        throw new OrchestrationError('host_unavailable', 'unreachable')
      },
      callOrchestrationWorkerServer: async () => {
        throw new OrchestrationError('host_unavailable', 'unreachable')
      }
    })

  it('fails a local worktree-create timeout and tells its coordinator once', async () => {
    open()
    const dispatch = starting()
    const receipt = await failStart(
      dispatch.id,
      dispatch.task_id,
      new GitCommandTimeoutError(180_000)
    )

    expect(receipt).toMatchObject({ state: 'failed' })
    const worker = db.getWorkerDispatch(dispatch.id)!
    expect(worker.state).toBe('failed')
    // A second report attempt is fenced, so the coordinator hears it exactly once.
    reportFailedWorkerStart(db, worker, () => {})
    const mailbox = dispatchReportMailbox(db, db.getDispatchContextById(dispatch.id)!)
    const told = db
      .getAllMessagesForHandle(mailbox)
      .filter((message) => message.payload?.includes(dispatch.id))
    expect(told).toHaveLength(1)
  })

  it('names the host terminal cap in the receipt and the failed-start mail, never a lost worker', async () => {
    open()
    const dispatch = starting()
    // The startup terminal's warning wraps the daemon's refusal before worker-start throws it.
    const refusal = new TerminalHostCapError(256, 256)
    const receipt = await failStart(
      dispatch.id,
      dispatch.task_id,
      new Error(`Failed to create the startup terminal for /repo/wt: ${refusal.message}`)
    )

    expect(receipt).toMatchObject({
      state: 'failed',
      blockedReason: 'terminal_host_cap',
      lastError: expect.stringContaining(
        "Orca refused the worker's terminal because this host is at its terminal limit (256 of 256 terminals in use)."
      ),
      nextCommands: ['orca orchestration worker-list --terminal-state reclaimable --json']
    })
    const mailbox = dispatchReportMailbox(db, db.getDispatchContextById(dispatch.id)!)
    const told = db
      .getAllMessagesForHandle(mailbox)
      .find((message) => message.payload?.includes(dispatch.id))
    expect(told?.subject).toBe("Worker couldn't start")
    expect(told?.body).toContain(
      `couldn't start task "work" (${dispatch.task_id}): Orca refused the worker's terminal because this host is at its terminal limit (256 of 256 terminals in use).`
    )
    expect(told?.body).toContain('`orchestration worker-release --dispatch <dispatch_id>`')
    expect(told?.body).not.toMatch(/lost|gone/)
  })

  it('reads a local start left unknown with no terminal as failed, but not a paired server one', async () => {
    open()
    const local = starting()
    db.markWorkerStartUnknown(local.id, 'worktree_create', 'git timed out.')
    const remote = starting({
      environmentId: 'environment-worker',
      environmentName: 'worker',
      peerFingerprint: 'peer-worker',
      protocolVersion: 3
    })
    db.markWorkerStartUnknown(remote.id, 'remote_attach', 'connection lost')

    const reads = await readDispatchWorkers(readRuntime(), [local.id, remote.id])
    const state = (id: string) => reads.find((read) => read.dispatchId === id)?.state

    expect(state(local.id)).toBe('failed')
    // Its server may yet be running it.
    expect(state(remote.id)).toBe('unverifiable')
  })

  it('fails a start a restart cut before it had a terminal, and tells its coordinator once', () => {
    open()
    const dispatch = starting()
    const runtime = { getRuntimeId: () => 'runtime_after_restart', notifyMessageArrived: () => {} }

    expect(settleRestartCutStart(db, dispatch.id, runtime)?.state).toBe('failed')
    settleRestartCutStart(db, dispatch.id, runtime)
    const mailbox = dispatchReportMailbox(db, db.getDispatchContextById(dispatch.id)!)
    const told = db
      .getAllMessagesForHandle(mailbox)
      .filter((message) => message.payload?.includes(dispatch.id))
    expect(told).toHaveLength(1)
  })

  it('fails a chat worker a restart cut while its Setup ran, and closes its waiting chat', async () => {
    open()
    const dispatch = starting()
    db.recordWorkerStage({
      dispatchId: dispatch.id,
      stage: 'terminal_readying',
      worktreeId: 'worktree-1',
      terminalHandle: 'structworker_1',
      setupState: 'running',
      effects: [
        { kind: 'setup', action: 'run', state: 'running', terminalId: 'term_setup' },
        { kind: 'terminal', role: 'agent', id: 'structworker_1', sessionId: 'chat-session-1' }
      ]
    })
    db.recordWorkerStage({ dispatchId: dispatch.id, stage: 'awaiting_agent' })
    const runtime = {
      getRuntimeId: () => 'runtime_after_restart',
      notifyMessageArrived: () => {},
      ensureStructuredAgentSessionHost: async () => {},
      currentLocalStructuredSessionPresentation: () => null,
      captureStructuredAgentSessionPresentation: () => null,
      retireStructuredAgentSessionTabFromSnapshot: () => {},
      removeCapturedStructuredSessionSavedTabs: () => {}
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close is mocked; it reads none of these.
    const failed = settleRestartCutStart(db, dispatch.id, runtime as never)
    expect(failed?.state).toBe('failed')
    expect(failed?.last_error).toBe(
      'Orca restarted while its Setup was still running, so it never sent its brief.'
    )
    await vi.waitFor(() => expect(closedChats).toEqual(['chat-session-1']))
  })
})
