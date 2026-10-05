import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

export type NewWorktreeWorkerFixture = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
  startWorker: (
    overrides?: Record<string, unknown>
  ) => Promise<{ result: unknown; task: ReturnType<OrchestrationDb['createTask']> }>
}

/** A worker-start runtime whose coordinator sits in `repo::parent` and asks for a new worktree. */
export function createNewWorktreeWorkerFixture(
  coordinatorPaneKey: string
): NewWorktreeWorkerFixture {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const runId = db.createRun({
    objective: 'Test new-worktree workers',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey
  }).id
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
  vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockReturnValue(new Promise(() => undefined))
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  // The brief is built before the spawn; these answer for the terminal it is offered to.
  vi.spyOn(runtime, 'createPreAllocatedTerminalHandle').mockReturnValue('term_worker')
  vi.spyOn(runtime, 'predictOrchestrationCliCommandForSpawn').mockResolvedValue('orca')
  vi.spyOn(runtime, 'observeTerminalLaunchTurnStart').mockResolvedValue('observed')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })

  async function startWorker(overrides: Record<string, unknown> = {}) {
    const task = db.createTask({ spec: 'new-worktree task', runId })
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
    const result = await method.handler(params, { runtime })
    return { result, task }
  }
  return { db, runtime, runId, startWorker }
}
