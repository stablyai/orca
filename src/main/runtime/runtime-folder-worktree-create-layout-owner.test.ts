import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

type CreateArgs = Parameters<typeof createRuntimeFolderWorktree>[0]

const repo: Repo = {
  id: 'repo-1',
  path: '/folder',
  displayName: 'folder',
  badgeColor: 'blue',
  addedAt: 1
}

function createDeps() {
  const createTerminal = vi
    .fn<CreateArgs['deps']['createTerminal']>()
    .mockResolvedValue({ handle: 'term-1', worktreeId: 'folder-1', title: null })
  const store = {
    getSettings: () => ({ workspaceDir: '/ws', nestWorkspaces: false }),
    setWorktreeMeta: (_target: HostWorktreeTarget, meta: Record<string, unknown>) => meta,
    getProjectHostSetups: () => []
  }
  const deps: CreateArgs['deps'] = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only these three store methods; any other would throw on call rather than read a wrong value.
    store: store as unknown as CreateArgs['deps']['store'],
    ptySpawnAvailable: true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    notifyWorktreesChanged: vi.fn(),
    emitCreated: vi.fn(),
    activate: vi.fn()
  }
  return { createTerminal, deps }
}

describe('layout-owner build: a folder create whose agent failed to start', () => {
  it('hands the window no start to retry', async () => {
    const { createTerminal, deps } = createDeps()
    createTerminal.mockRejectedValueOnce(new Error('pty unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await createRuntimeFolderWorktree({
      request: { repoSelector: `id:${repo.id}`, name: 'task', activate: true },
      repo,
      createdWithAgent: 'codex',
      startup: { command: 'codex' },
      deps
    })
    expect(deps.activate).toHaveBeenCalledWith(repo.id, expect.any(String), undefined, undefined)
    warn.mockRestore()
  })
})
