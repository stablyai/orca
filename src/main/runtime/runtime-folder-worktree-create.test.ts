/** A folder workspace create in a Perforce project becomes a copy on its own stream. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

const perforceCopies = vi.hoisted(() => {
  const summary = {
    name: 'task',
    copyRoot: '/folder.wt/task',
    stream: '//g/dev_wt_task',
    streamChoice: 'child',
    space: { copiedBytes: 0, usedBytes: 0, cloned: true, freeBytesAfter: 0 },
    warnings: [],
    unityVersionControlBinding: null
  }
  return {
    summary,
    createRuntimePerforceCopy: vi.fn(async () => ({
      worktreeId: 'repo-1::/folder.wt/task',
      summary
    }))
  }
})

vi.mock('./runtime-perforce-copy-commands', () => ({
  createRuntimePerforceCopy: perforceCopies.createRuntimePerforceCopy
}))

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

describe('a workspace create in a Perforce project', () => {
  it('becomes a copy on its own stream instead of sharing the project folder', async () => {
    const { deps } = createDeps()
    const result = await createRuntimeFolderWorktree({
      request: {
        repoSelector: `id:${repo.id}`,
        name: 'task',
        perforceCopy: { stream: { kind: 'child' }, settings: { copyMinFreeSpaceGb: 4 } }
      },
      repo,
      deps
    })
    expect(perforceCopies.createRuntimePerforceCopy).toHaveBeenCalledWith(
      repo,
      { workspaceName: 'task', stream: { kind: 'child' }, settings: { copyMinFreeSpaceGb: 4 } },
      { workspaceDir: '/ws', nestWorkspaces: false }
    )
    expect(result.worktree.id).toBe('repo-1::/folder.wt/task')
    expect(result.perforceCopy).toBe(perforceCopies.summary)
  })

  it('shares the project folder when no copy was asked for', async () => {
    perforceCopies.createRuntimePerforceCopy.mockClear()
    const { deps } = createDeps()
    await createRuntimeFolderWorktree({
      request: { repoSelector: `id:${repo.id}`, name: 'task' },
      repo,
      deps
    })
    expect(perforceCopies.createRuntimePerforceCopy).not.toHaveBeenCalled()
  })
})
