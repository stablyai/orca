import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export function mockWorkerStartReady(
  runtime: OrcaRuntimeService,
  coordinatorPaneKey: string,
  options?: { ready?: boolean }
): void {
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord'
      ? coordinatorPaneKey
      : handle === 'term_worker'
        ? 'tab_worker:leaf_worker'
        : null
  )
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
  )
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
    id: 'repo::worktree'
  } as never)
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
    satisfied: options?.ready !== false,
    status: 'running',
    exitCode: null
  })
  vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
    handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
  )
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_worker',
    accepted: true,
    bytesWritten: 1
  })
}
