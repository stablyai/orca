import { expect, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import type { RpcContext } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

export type OrchestrationWorkerReleaseHarness = {
  setup: () => void
  cleanup: () => void
  call: (
    name: string,
    params: Record<string, unknown>,
    context?: Partial<RpcContext>
  ) => Promise<unknown>
  startWorker: (options?: { terminal?: string }) => Promise<{ taskId: string; dispatchId: string }>
  settle: (taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed') => void
  startSettledWorker: (
    outcome?: 'succeeded' | 'failed',
    options?: { terminal?: string }
  ) => Promise<{ taskId: string; dispatchId: string }>
  observeWorkerAsExited: () => void
  deferred: typeof deferred
  coordinatorPaneKey: string
  workerPaneKey: string
  readonly db: OrchestrationDb
  readonly runtime: OrcaRuntimeService
  readonly activeRunId: string
  readonly inspectProcessLiveness: ReturnType<typeof vi.fn>
}

export function createOrchestrationWorkerReleaseHarness(): OrchestrationWorkerReleaseHarness {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let inspectProcessLiveness: ReturnType<typeof vi.fn>

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    // A positive exact host observation is the fixture's process-exit proof. The close boolean
    // alone is intentionally not enough for production release settlement.
    inspectProcessLiveness = vi.fn().mockResolvedValue('exited')
    ;(
      runtime as unknown as {
        inspectTerminalProcessIncarnationLiveness: typeof inspectProcessLiveness
      }
    ).inspectTerminalProcessIncarnationLiveness = inspectProcessLiveness
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker' || handle === 'term_reminted'
          ? workerPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' || handle === 'term_reminted'
        ? ({
            terminalHandle: handle,
            worktreeId: 'repo::worktree',
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree'
    } as never)
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
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue(null)
    vi.spyOn(runtime, 'preflightWorktreeManagedCliExecutable').mockReturnValue('orca')
    vi.spyOn(runtime, 'assertTerminalManagedCliAvailable').mockImplementation(() => {})
    vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockImplementation(
      (handle) =>
        ({
          executable: 'orca',
          runtimeId: runtime.getRuntimeId(),
          executionHostId: 'local',
          workspaceKey: 'worktree:repo::worktree',
          terminalHandle: handle
        }) as never
    )
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
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  function cleanup(): void {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  }

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(
    name: string,
    params: Record<string, unknown>,
    context?: Partial<RpcContext>
  ) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, { ...ctx, ...context })
  }

  async function startWorker(options: { terminal?: string } = {}): Promise<{
    taskId: string
    dispatchId: string
  }> {
    const task = db.createTask({ spec: 'release fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: 'codex' })
    })) as { dispatchId: string; state: string }
    expect(result.state, JSON.stringify(result)).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  function settle(taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed'): void {
    const settlement = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
    expect(settlement.action).toBe('settled')
  }

  function observeWorkerAsExited(): void {
    vi.mocked(runtime.showTerminal).mockImplementation(
      async (handle) =>
        ({
          handle,
          worktreeId: 'repo::worktree',
          connected: false,
          status: 'exited',
          ptyId: 'runtime_test:term_worker',
          incarnationId: '1',
          executionHostId: 'local'
        }) as never
    )
    vi.mocked(runtime.getTerminalLivenessVerdict).mockReturnValue({ status: 'exited' })
    inspectProcessLiveness.mockResolvedValue('exited')
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded',
    options: { terminal?: string } = {}
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker(options)
    settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  return {
    setup,
    cleanup,
    call,
    startWorker,
    settle,
    startSettledWorker,
    observeWorkerAsExited,
    deferred,
    coordinatorPaneKey,
    workerPaneKey,
    get db() {
      return db
    },
    get runtime() {
      return runtime
    },
    get activeRunId() {
      return activeRunId
    },
    get inspectProcessLiveness() {
      return inspectProcessLiveness
    }
  }
}
