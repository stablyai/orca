import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'

function createRuntime(worktrees: unknown[], folders: unknown[]) {
  const runtime = Object.create(OrcaRuntimeWithListManagedWorktrees.prototype) as {
    listPluginWorkspaces(): Promise<unknown>
    listResolvedWorktrees: ReturnType<typeof vi.fn>
    store: { getFolderWorkspaces: ReturnType<typeof vi.fn> }
  }
  runtime.listResolvedWorktrees = vi.fn(async () => worktrees)
  runtime.store = { getFolderWorkspaces: vi.fn(() => folders) }
  return runtime
}

type PluginWorkspaceListResult = {
  workspaces: {
    ref: string
    hostId: string
    branch?: string
    displayName: string
  }[]
}

function worktree(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `repo::/private/worktree-${index}`,
    path: `/private/worktree-${index}`,
    git: { path: `/private/worktree-${index}`, branch: `branch-${index}` },
    identity: { key: `wt2:local:instance-${index}` },
    hostId: 'local',
    displayName: `Worktree ${index}`,
    comment: `Comment ${index}`,
    ...overrides
  }
}

describe('OrcaRuntimeService.listPluginWorkspaces', () => {
  it('projects one worktree and one folder through the runtime-owned catalog', async () => {
    const runtime = createRuntime(
      [
        {
          id: 'repo::/secret/worktree',
          path: '/secret/worktree',
          git: { path: '/secret/worktree', branch: 'feature/plugin-list' },
          identity: { key: 'wt2:ssh%3Atarget:instance/one' },
          hostId: 'ssh:target',
          displayName: 'Plugin listing',
          workspaceStatus: 'in-progress',
          comment: 'runtime-owned'
        },
        {
          id: 'repo::/secret/detached',
          path: '/secret/detached',
          git: { path: '/secret/detached', branch: '' },
          identity: { key: 'wt2:local:detached' },
          hostId: 'local',
          displayName: 'Detached',
          comment: ''
        }
      ],
      [
        {
          id: 'folder id/one',
          name: 'Notes',
          folderPath: '/secret/notes',
          executionHostId: 'runtime:peer',
          workspaceStatus: 'ready',
          comment: 'folder-owned'
        }
      ]
    )

    const result = await runtime.listPluginWorkspaces()

    expect(result).toEqual({
      workspaces: [
        {
          ref: 'identity:wt2%3Assh%253Atarget%3Ainstance%2Fone',
          hostId: 'ssh:target',
          branch: 'feature/plugin-list',
          displayName: 'Plugin listing'
        },
        {
          ref: 'identity:wt2%3Alocal%3Adetached',
          hostId: 'local',
          displayName: 'Detached'
        },
        {
          ref: 'id:folder%20id%2Fone',
          hostId: 'runtime:peer',
          displayName: 'Notes'
        }
      ]
    })
    expect(JSON.stringify(result)).not.toMatch(/secret|folderPath|"path"|"git"/)
    expect(runtime.listResolvedWorktrees).toHaveBeenCalledTimes(1)
    expect(runtime.store.getFolderWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('bounds combined source order and caps only contract-defined text', async () => {
    const long = 'x'.repeat(5000)
    const runtime = createRuntime(
      Array.from({ length: 999 }, (_, index) =>
        worktree(
          index,
          index === 0 ? { displayName: long, git: { path: '/private/0', branch: long } } : {}
        )
      ),
      [
        {
          id: 'first-folder',
          name: long,
          folderPath: '/private/first',
          executionHostId: 'local',
          workspaceStatus: long,
          comment: long
        },
        {
          id: 'excluded-folder',
          name: 'Excluded',
          folderPath: '/private/excluded',
          executionHostId: 'local',
          comment: ''
        }
      ]
    )

    const result = (await runtime.listPluginWorkspaces()) as PluginWorkspaceListResult

    expect(result.workspaces).toHaveLength(1000)
    expect(result.workspaces[0]?.ref).toBe('identity:wt2%3Alocal%3Ainstance-0')
    expect(result.workspaces[0]?.displayName).toBe('x'.repeat(512))
    expect(result.workspaces[0]?.branch).toBe('x'.repeat(512))
    expect(result.workspaces[998]?.ref).toBe('identity:wt2%3Alocal%3Ainstance-998')
    expect(result.workspaces[999]).toMatchObject({
      ref: 'id:first-folder',
      displayName: 'x'.repeat(512)
    })
    expect(result.workspaces.some(({ ref }) => ref === 'id:excluded-folder')).toBe(false)
  })

  it('keeps opaque references stable across locator and display-name changes', async () => {
    const identity = { key: 'wt2:local:stable-instance' }
    const first = createRuntime(
      [worktree(1, { identity })],
      [
        {
          id: 'stable-folder',
          name: 'Before',
          folderPath: '/private/before',
          executionHostId: 'local'
        }
      ]
    )
    const second = createRuntime(
      [
        worktree(1, {
          id: 'repo::/different/private/path',
          path: '/different/private/path',
          git: { path: '/different/private/path', branch: '' },
          identity
        })
      ],
      [
        {
          id: 'stable-folder',
          name: '  After  ',
          folderPath: '/different/private/folder',
          executionHostId: 'local'
        }
      ]
    )

    const before = (await first.listPluginWorkspaces()) as PluginWorkspaceListResult
    const after = (await second.listPluginWorkspaces()) as PluginWorkspaceListResult

    expect(after.workspaces.map(({ ref }) => ref)).toEqual(before.workspaces.map(({ ref }) => ref))
    expect(after.workspaces[1]).toEqual({
      ref: 'id:stable-folder',
      hostId: 'local',
      displayName: '  After  '
    })
    expect(JSON.stringify(after)).not.toMatch(/different|private|folderPath|"path"|"git"/)
  })

  it('omits unaddressable legacy rows without suppressing valid catalog entries', async () => {
    const runtime = createRuntime(
      [worktree(0, { identity: undefined }), worktree(1, { hostId: undefined }), worktree(2)],
      [
        {
          id: 'folder-after-legacy',
          name: 'Folder after legacy',
          folderPath: '/private/folder',
          executionHostId: 'local'
        }
      ]
    )

    await expect(runtime.listPluginWorkspaces()).resolves.toEqual({
      workspaces: [
        {
          ref: 'identity:wt2%3Alocal%3Ainstance-2',
          hostId: 'local',
          branch: 'branch-2',
          displayName: 'Worktree 2'
        },
        {
          ref: 'id:folder-after-legacy',
          hostId: 'local',
          displayName: 'Folder after legacy'
        }
      ]
    })
  })
})
