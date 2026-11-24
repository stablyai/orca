import os from 'node:os'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../../../../orca-runtime'
import { isStreamingMethod, eraseRpcMethods, type RpcContext } from '../../../../core'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { recordWorkerResumeSession } from '../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { PtyProcessInfo } from '../../../../../../providers/pty/process-info'

export const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const workerIncarnation = 'pty-worker:11111111-1111-4111-8111-111111111111'

export function isStartReceipt(value: unknown): value is { dispatchId: string; state: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispatchId' in value &&
    typeof value.dispatchId === 'string' &&
    'state' in value &&
    typeof value.state === 'string'
  )
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

/** A runtime with one coordinator and a worker terminal `term_worker`, its pane and process stubbed. */
export function createWorkerReleaseFixture() {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === 'term_worker' ? workerIncarnation : null
  )
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
    handle === 'term_worker'
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies only the authority fields worker start reads.
        ({
          terminalHandle: handle,
          paneKey: workerPaneKey,
          processIncarnation: workerIncarnation,
          hostScope: { kind: 'local', hostId: 'local' }
        } as never)
      : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only the handle, worktree and status of a shown terminal.
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker start reads only the workspace id.
    { id: 'repo::worktree' } as never
  )
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term_worker',
    worktreeId: 'repo::worktree',
    title: 'worker'
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: 'term_worker',
    status: 'running',
    tail: ['worker output line 1', 'worker output line 2'],
    truncated: false,
    nextCursor: '2'
  })
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: 'term_worker',
    tabId: 'tab-worker',
    ptyKilled: true
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const activeRunId = db.createRun({
    objective: 'Release recovery test Run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey
  }).id
  const ctx: RpcContext = { runtime }

  async function call(name: string, params: Record<string, unknown>) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method || isStreamingMethod(method)) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const task = db.createTask({ spec: 'release recovery fixture task', runId: activeRunId })
    const result: unknown = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    if (!isStartReceipt(result)) {
      throw new Error('worker start returned no receipt')
    }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker()
    expect(
      db.settleWorkerReport({
        taskId: worker.taskId,
        dispatchId: worker.dispatchId,
        outcome,
        result: `worker ${outcome}`
      }).action
    ).toBe('settled')
    return worker
  }

  /** A current worker whose terminal is gone; the local owner answers with `listing`. */
  function loseWorkerTerminal(
    listing: () => Promise<{ processes: PtyProcessInfo[]; inProcessOwner: boolean }>
  ): void {
    runtime.setPtyController({
      write: () => false,
      kill: () => false,
      getForegroundProcess: async () => null,
      listLocalProcessesForExitProof: listing
    })
  }

  function goneAfterSettle(): void {
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.spyOn(runtime, 'resolveTerminalHandleByProcessIncarnation').mockReturnValue(null)
  }

  function saveSession(resourceId: string, sessionId: string): string {
    const transcriptPath = path.join(os.tmpdir(), `${sessionId}.jsonl`)
    recordWorkerResumeSession(db, resourceId, {
      paneKey: workerPaneKey,
      processIncarnation: workerIncarnation,
      connectionId: null,
      agent: 'claude',
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      observedAt: 0
    })
    return transcriptPath
  }

  return {
    db,
    runtime,
    activeRunId,
    call,
    startWorker,
    startSettledWorker,
    loseWorkerTerminal,
    goneAfterSettle,
    saveSession
  }
}

export type WorkerReleaseFixture = ReturnType<typeof createWorkerReleaseFixture>
