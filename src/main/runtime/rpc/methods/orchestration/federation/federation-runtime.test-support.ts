import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RuntimeTerminalShow } from '../../../../../../shared/runtime-terminal-contracts'

export function configureFederationWorkerRuntime(
  runtime: OrcaRuntimeService,
  handle = 'term_windows_worker'
): void {
  const terminal: RuntimeTerminalShow = {
    handle,
    ptyId: handle,
    worktreeId: 'repo::windows-worktree',
    worktreePath: '/workspace/windows-worktree',
    branch: 'remote-worker',
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'Codex',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    paneRuntimeId: 1,
    rendererGraphEpoch: 1
  }
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({
    id: 'windows-repo',
    kind: 'git',
    path: '/workspace/repo',
    displayName: 'Windows repo',
    badgeColor: 'blue',
    addedAt: 1
  })
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: {
      id: terminal.worktreeId,
      repoId: 'repo',
      path: terminal.worktreePath,
      branch: terminal.branch,
      head: 'head',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Remote worker',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    },
    startupTerminal: { spawned: true, handle },
    setupReceipt: {
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    }
  })
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [
      terminal,
      {
        ...terminal,
        handle: 'term_windows_setup',
        ptyId: 'term_windows_setup',
        tabId: 'tab_setup',
        title: 'Setup'
      }
    ],
    totalCount: 2,
    truncated: false
  })
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle,
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
    handle,
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue(terminal)
  vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
    status: 'live',
    ptyIds: [handle]
  })
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle,
    status: 'running',
    tail: ['remote output'],
    truncated: false,
    nextCursor: '1',
    limited: false
  })
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle,
    tabId: 'tab-windows-worker',
    ptyKilled: true
  })
}
