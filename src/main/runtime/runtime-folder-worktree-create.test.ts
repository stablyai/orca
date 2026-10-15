/** The startup terminal a folder workspace's create spawns; this path forwards a reserved pane itself. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'

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
    setWorktreeMeta: (_id: string, meta: Record<string, unknown>) => meta,
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

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

async function startupTerminalOptions(startupPaneKey?: string): Promise<Record<string, unknown>> {
  const { createTerminal, deps } = createDeps()
  await createRuntimeFolderWorktree({
    request: {
      repoSelector: `id:${repo.id}`,
      name: 'task',
      ...(startupPaneKey ? { startupPaneKey } : {})
    },
    repo,
    createdWithAgent: 'codex',
    startup: { command: 'codex' },
    deps
  })
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('a folder workspace create with a startup agent', () => {
  it('seeds a headless activated folder workspace without a paired viewer', async () => {
    const { deps, createTerminal } = createDeps()
    deps.provisionInBackground = () => true
    const result = await createRuntimeFolderWorktree({
      request: { repoSelector: `id:${repo.id}`, name: 'headless', activate: true },
      repo,
      deps
    })
    expect(createTerminal).toHaveBeenCalledWith(`id:${result.worktree.id}`, { surfaceOwner: false })
  })

  it('creates the startup terminal under the pane the caller reserved', async () => {
    expect(await startupTerminalOptions(`${TAB_ID}:${LEAF_ID}`)).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
  })

  it('leaves the pane to the runtime when none was reserved', async () => {
    const options = await startupTerminalOptions()
    expect(options).not.toHaveProperty('tabId')
    expect(options).not.toHaveProperty('leafId')
  })
})

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
