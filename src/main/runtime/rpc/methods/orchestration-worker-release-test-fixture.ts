import { vi, type Mock } from 'vitest'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

/** One in-memory runtime, database and Run wired for the worker-release specs. */
type WorkerReleaseFixture = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  ctx: RpcContext
  activeRunId: string
  inspectProcessLiveness: Mock
}

export function createWorkerReleaseFixture(panes: {
  coordinatorPaneKey: string
  workerPaneKey: string
}): WorkerReleaseFixture {
  const { coordinatorPaneKey, workerPaneKey } = panes
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const inspectProcessLiveness = vi.fn().mockResolvedValue('live')
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
  const activeRunId = db.createRun({
    objective: 'Release test Run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey
  }).id
  const ctx: RpcContext = { runtime }
  return { db, runtime, ctx, activeRunId, inspectProcessLiveness }
}
