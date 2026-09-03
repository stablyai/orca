import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

export const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export type CreateWorktreeResult = Awaited<ReturnType<OrcaRuntimeService['createManagedWorktree']>>

type MockCreatedWorktreeOptions = {
  hookFound?: boolean
  startupPolicy?: 'start-immediately' | 'wait-for-setup'
  state?: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
  terminals?: { handle: string; title: string }[]
  setupTerminalHandle?: string
}

export type NewWorktreeTestState = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
}

export function createNewWorktreeTestSupport(args: {
  getWorkerLaunchTokenHash: () => string | null
  setWorkerLaunchTokenHash: (hash: string | null) => void
}) {
  function setup(): NewWorktreeTestState {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const runId = db.createRun({
      objective: 'Test new-worktree workers',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    args.setWorkerLaunchTokenHash(null)
    vi.spyOn(runtime, 'createPreAllocatedTerminalHandle').mockReturnValue('term_worker')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? coordinatorPaneKey
        : handle === 'term_worker'
          ? 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker' && args.getWorkerLaunchTokenHash()
        ? ({
            runtimeId: runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: 'pty_worker',
            worktreeId: 'repo::created',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'runtime_test:term_worker:1',
            launchTokenHash: args.getWorkerLaunchTokenHash(),
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::parent',
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      kind: 'git'
    } as never)
    vi.spyOn(runtime, 'createTerminal')
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_worker', title: 'Codex' }],
      totalCount: 1,
      truncated: false
    } as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(
      new Promise(() => undefined)
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'getWorktreeOrchestrationCliCommand').mockResolvedValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    return { db, runtime, runId }
  }

  function cleanup(db: OrchestrationDb, paths: string[]): void {
    db.close()
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  }

  async function startWorker(state: NewWorktreeTestState, overrides: Record<string, unknown> = {}) {
    const task = state.db.createTask({ spec: 'new-worktree task', runId: state.runId })
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStart'
    )
    if (!method) {
      throw new Error('workerStart method is not registered')
    }
    const params = method.params!.parse({
      task: task.id,
      from: 'term_coord',
      worktree: 'new-child',
      name: 'new-worker',
      agent: 'codex',
      ...overrides
    })
    const result = await method.handler(params, { runtime: state.runtime })
    return { result, task }
  }

  function ownedResourceCount(db: OrchestrationDb, dispatchId: string): number {
    const raw = (
      db as unknown as {
        db: { prepare: (sql: string) => { get: (...args: unknown[]) => { count: number } } }
      }
    ).db
    return raw
      .prepare(
        `SELECT COUNT(*) AS count
           FROM worker_terminal_resources
          WHERE owner_dispatch_id = ?`
      )
      .get(dispatchId).count
  }

  function mockCreatedWorktree(
    state: NewWorktreeTestState,
    options?: MockCreatedWorktreeOptions
  ): void {
    const hookFound = options?.hookFound ?? true
    const stateValue = options?.state ?? (hookFound ? 'running' : 'not_configured')
    const created = {
      worktree: { id: 'repo::created', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: stateValue === 'skipped' ? 'skip' : 'run',
        hookFound,
        startupPolicy: options?.startupPolicy ?? 'start-immediately',
        state: stateValue,
        terminalHandle:
          options?.setupTerminalHandle ??
          options?.terminals?.find((terminal) => terminal.title === 'Setup')?.handle
      }
    } as never
    vi.spyOn(state.runtime, 'createManagedWorktree').mockImplementation(async (createArgs) => {
      args.setWorkerLaunchTokenHash(
        createArgs.startupLaunchToken
          ? createHash('sha256').update(createArgs.startupLaunchToken).digest('hex')
          : null
      )
      await createArgs.startupPromptFactory?.('repo::created')
      return created
    })
    if (options?.terminals) {
      vi.mocked(state.runtime.listTerminals).mockResolvedValue({
        terminals: options.terminals,
        totalCount: options.terminals.length,
        truncated: false
      } as never)
    }
  }

  return { setup, cleanup, startWorker, ownedResourceCount, mockCreatedWorktree }
}
