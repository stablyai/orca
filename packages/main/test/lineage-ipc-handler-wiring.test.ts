import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageManualLink } from '../../../src/shared/lineage-discovery-types'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>(),
  lookup: vi.fn(),
  listWorktrees: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      mocks.handlers.delete(channel)
    }
  }
}))
vi.mock('../../../src/main/lineage/lineage-pr-head-branch', () => ({
  lookupLineagePullRequestHeadBranch: mocks.lookup
}))
vi.mock('../../../src/main/git/worktree', () => ({ listWorktrees: mocks.listWorktrees }))

import { registerLineageIpcHandlers } from '../../../src/main/ipc/lineage-ipc-handlers'

function makeStore(): { store: LineageStoreContract; links: () => LineageManualLink[] } {
  let links: LineageManualLink[] = []
  return {
    store: {
      getRepos: () => [{ id: 'r1', path: '/repos/api', displayName: 'api' }],
      getLineageManualLinks: () => links,
      setLineageManualLinks: (_key, next) => {
        links = next
      }
    },
    links: () => links
  }
}

beforeEach(() => {
  mocks.handlers.clear()
  mocks.lookup.mockReset()
  mocks.listWorktrees.mockReset()
})

describe('lineage:add-manual-link wiring', () => {
  it('resolves a PR head branch through the real lookup', async () => {
    mocks.lookup.mockResolvedValue('feat/x')
    const { store, links } = makeStore()
    registerLineageIpcHandlers(store)
    const add = mocks.handlers.get('lineage:add-manual-link')
    await add?.({}, { parentWorkspaceKey: 'folder:t', target: { kind: 'pr', reference: 'api#3' } })
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
    expect(links()[0]).toMatchObject({ number: 3, branch: 'feat/x' })
  })

  it('validates a local worktree against the git worktree list', async () => {
    mocks.listWorktrees.mockResolvedValue([
      {
        path: '/repos/api-wt',
        head: 'h',
        branch: 'refs/heads/f',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const { store, links } = makeStore()
    registerLineageIpcHandlers(store)
    const add = mocks.handlers.get('lineage:add-manual-link')
    const unknown = await add?.(
      {},
      {
        parentWorkspaceKey: 'folder:t',
        target: { kind: 'worktree', repoId: 'r1', worktreePath: '/nope' }
      }
    )
    expect(unknown).toEqual({ success: false, error: 'Worktree is not part of this repository' })
    await add?.(
      {},
      {
        parentWorkspaceKey: 'folder:t',
        target: { kind: 'worktree', repoId: 'r1', worktreePath: '/repos/api-wt' }
      }
    )
    expect(mocks.listWorktrees).toHaveBeenCalledWith('/repos/api')
    expect(links()).toHaveLength(1)
  })
})
