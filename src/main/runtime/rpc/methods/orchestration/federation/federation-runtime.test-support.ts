import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

export function configureFederationWorkerRuntime(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'windows-repo', kind: 'git' } as never)
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
    startupTerminal: { spawned: true, handle: 'term_windows_worker' },
    setupReceipt: {
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    }
  } as never)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [
      { handle: 'term_windows_worker', title: 'Codex' },
      { handle: 'term_windows_setup', title: 'Setup' }
    ],
    totalCount: 2,
    truncated: false
  } as never)
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
    'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('windows_runtime:pty:1')
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: 'term_windows_worker',
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    worktreeId: 'repo::windows-worktree',
    status: 'running'
  } as never)
  vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
    status: 'live',
    ptyIds: ['term_windows_worker']
  })
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    status: 'running',
    entries: [{ cursor: 1, text: 'remote output' }],
    nextCursor: '1',
    limited: false
  } as never)
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: 'term_windows_worker',
    tabId: 'tab-windows-worker',
    ptyKilled: true
  } as never)
}
