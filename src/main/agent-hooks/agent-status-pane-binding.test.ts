import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  indexPersistedPaneKeyPtyIds,
  resolveAgentWorkspaceExecutionHostId
} from './agent-status-pane-binding'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)
const PTY = 'wt-1__pty-1'

describe('indexPersistedPaneKeyPtyIds', () => {
  it('maps layout leaves to pane keys and ignores empty bindings', () => {
    expect(
      indexPersistedPaneKeyPtyIds({
        'tab-1': { ptyIdsByLeafId: { [LEAF]: PTY, 'leaf-empty': '' } },
        'tab-2': undefined,
        'tab-3': {}
      })
    ).toEqual(new Map([[PANE, PTY]]))
  })
})

describe('resolveAgentWorkspaceExecutionHostId', () => {
  const localRepo = {
    id: 'local-repo',
    connectionId: null,
    executionHostId: 'local' as const
  }
  const runtimeRepo = {
    id: 'runtime-repo',
    connectionId: null,
    executionHostId: 'runtime:ephemeral-vm-1' as const
  }
  const futureHostRepo = {
    id: 'future-repo',
    connectionId: null,
    executionHostId: 'container:future-host'
  }
  const deps = {
    getRepo: (repoId: string) =>
      [localRepo, runtimeRepo, futureHostRepo].find((candidate) => candidate.id === repoId),
    getWorktreeMeta: (worktreeId: string) => {
      if (worktreeId === 'local-repo::/runtime-worktree') {
        return { hostId: 'runtime:worktree-owner' }
      }
      if (worktreeId === 'runtime-repo::/local-worktree') {
        return { hostId: 'local' }
      }
      if (worktreeId === 'local-repo::/future-worktree') {
        return { hostId: 'container:future-host' }
      }
      return undefined
    },
    getFolderWorkspace: (id: string) =>
      id === 'folder-runtime' ? { projectGroupId: 'group-runtime', connectionId: null } : undefined,
    getProjectGroups: () => [
      {
        id: 'group-runtime',
        connectionId: null,
        executionHostId: 'runtime:ephemeral-vm-1'
      }
    ]
  }

  it('positively identifies local ownership and rejects runtime hosts', () => {
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/repo', deps)).toBe('local')
    expect(resolveAgentWorkspaceExecutionHostId('runtime-repo::/repo', deps)).toBe(
      'runtime:ephemeral-vm-1'
    )
    expect(resolveAgentWorkspaceExecutionHostId('folder:folder-runtime', deps)).toBe(
      'runtime:ephemeral-vm-1'
    )
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/runtime-worktree', deps)).toBe(
      'runtime:worktree-owner'
    )
    expect(resolveAgentWorkspaceExecutionHostId('runtime-repo::/local-worktree', deps)).toBe(
      'local'
    )
    expect(resolveAgentWorkspaceExecutionHostId('future-repo::/repo', deps)).toBeNull()
    expect(resolveAgentWorkspaceExecutionHostId('local-repo::/future-worktree', deps)).toBeNull()
  })

  it('treats missing workspace provenance as unknown', () => {
    expect(resolveAgentWorkspaceExecutionHostId('missing::/repo', deps)).toBeNull()
    expect(resolveAgentWorkspaceExecutionHostId(undefined, deps)).toBeNull()
  })
})
