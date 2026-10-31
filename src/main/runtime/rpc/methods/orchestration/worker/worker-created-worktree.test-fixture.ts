import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../../../../shared/worktree/meta-persisted-defaults'

export function mockWorkerCreatedWorktree(
  runtime: OrcaRuntimeService,
  options?: {
    hookFound?: boolean
    startupPolicy?: 'start-immediately' | 'wait-for-setup'
    state?: 'running' | 'skipped' | 'not_configured' | 'spawn_failed'
    terminals?: { handle: string; title: string }[]
    setupTerminalHandle?: string
  }
) {
  const hookFound = options?.hookFound ?? true
  const state = options?.state ?? (hookFound ? 'running' : 'not_configured')
  vi.spyOn(runtime, 'createManagedWorktree').mockImplementation(async (args) => {
    args.onWorkspaceCreated?.('repo::created')
    return {
      worktree: {
        ...WORKTREE_META_PERSISTED_DEFAULTS,
        id: 'repo::created',
        repoId: 'repo',
        displayName: '',
        comment: '',
        isUnread: false,
        sortOrder: 0,
        lastActivityAt: 0,
        path: '/repo/created',
        head: 'head',
        branch: 'created',
        isBare: false,
        isMainWorktree: false
      },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: state === 'skipped' ? 'skip' : 'run',
        hookFound,
        startupPolicy: options?.startupPolicy ?? 'start-immediately',
        state,
        terminalHandle:
          options?.setupTerminalHandle ??
          options?.terminals?.find((terminal) => terminal.title === 'Setup')?.handle
      }
    }
  })
  if (options?.terminals) {
    vi.mocked(runtime.listTerminals).mockResolvedValue({
      terminals: options.terminals,
      totalCount: options.terminals.length,
      truncated: false
    } as never)
  }
}
