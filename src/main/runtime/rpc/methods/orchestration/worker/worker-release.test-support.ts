import { expect, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods, type RpcContext } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import type { RuntimeStore } from '../../../../runtime-store-contract'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  getAppEnvironment,
  hasAppEnvironment,
  setAppEnvironment,
  type AppEnvironment
} from '../../../../../../shared/app-environment'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'

type WorkerStartOptions = { terminal?: string; agent?: TuiAgent }

function isWorkerStartResult(value: unknown): value is { state: 'ready'; dispatchId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    value.state === 'ready' &&
    'dispatchId' in value &&
    typeof value.dispatchId === 'string'
  )
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

export type OrchestrationWorkerReleaseHarness = {
  setup: (options?: { userDataDir?: string }) => void
  /** Close the database and open it again from a fresh runtime; file-backed setups only. */
  restart: () => void
  cleanup: () => void
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
  startWorker: (options?: WorkerStartOptions) => Promise<{ taskId: string; dispatchId: string }>
  settle: (taskId: string, dispatchId: string, outcome: 'succeeded' | 'failed') => void
  startSettledWorker: (
    outcome?: 'succeeded' | 'failed',
    options?: WorkerStartOptions
  ) => Promise<{ taskId: string; dispatchId: string }>
  deferred: typeof deferred
  coordinatorPaneKey: string
  workerPaneKey: string
  readonly db: OrchestrationDb
  readonly runtime: OrcaRuntimeService
  readonly activeRunId: string
  readonly inspectProcessLiveness: ReturnType<typeof vi.fn>
}

/** Layout-owner builds: an empty store whose session holds main's layout, which binds the panes. */
function workerReleaseLayoutStore(): RuntimeStore {
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

export function createOrchestrationWorkerReleaseHarness(): OrchestrationWorkerReleaseHarness {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string
  let inspectProcessLiveness: ReturnType<typeof vi.fn>
  let userDataDir: string | undefined
  let previousEnvironment: AppEnvironment | null = null

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(options: { userDataDir?: string } = {}): void {
    userDataDir = options.userDataDir
    if (userDataDir) {
      const path = userDataDir
      previousEnvironment = hasAppEnvironment() ? getAppEnvironment() : null
      setAppEnvironment({
        getPath: () => path,
        getAppPath: () => path,
        getVersion: () => '0.0.0-test',
        isPackaged: () => false,
        onWillQuit: () => {},
        exit: () => {},
        getAppMetrics: () => []
      })
    }
    startRuntime()
    activeRunId = db.createRun({
      objective: 'Release test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
  }

  // A file-backed runtime opens its database itself, as startup does, so armed deadlines recover.
  function startRuntime(): void {
    runtime = new OrcaRuntimeService(ORCA_LAYOUT_OWNER_IS_MAIN ? workerReleaseLayoutStore() : null)
    if (userDataDir) {
      db = runtime.getOrchestrationDb()
    } else {
      db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
    }
    dbOpen = true
    configureRuntime()
    ctx = { runtime }
  }

  function restart(): void {
    getWorkerTerminalAutoReleaseScheduler(runtime).clear()
    db.close()
    dbOpen = false
    vi.restoreAllMocks()
    startRuntime()
  }

  function configureRuntime(): void {
    inspectProcessLiveness = vi.fn().mockResolvedValue('live')
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
  }

  function cleanup(): void {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
    if (previousEnvironment) {
      setAppEnvironment(previousEnvironment)
      previousEnvironment = null
    }
  }

  function findMethod(name: string) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(options: WorkerStartOptions = {}): Promise<{
    taskId: string
    dispatchId: string
  }> {
    const task = db.createTask({ spec: 'release fixture task', runId: activeRunId })
    const result = await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      ...(options.terminal ? { terminal: options.terminal } : { agent: options.agent ?? 'codex' })
    })
    if (!isWorkerStartResult(result)) {
      throw new Error('Expected worker-start to return a ready dispatch')
    }
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

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded',
    options: WorkerStartOptions = {}
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker(options)
    settle(worker.taskId, worker.dispatchId, outcome)
    return worker
  }

  return {
    setup,
    restart,
    cleanup,
    call,
    startWorker,
    settle,
    startSettledWorker,
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
