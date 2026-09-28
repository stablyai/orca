/** The startup terminal a folder workspace's create spawns; this path forwards a reserved pane itself. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'

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
    markTrusted: vi.fn(),
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
