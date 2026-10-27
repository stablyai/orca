import { describe, expect, it } from 'vitest'
import type { FolderWorkspaceHostState } from '../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { getVerifiedLocalFolderWorkspaceKeys } from './verified-local-folder-workspaces'

const folder = (patch: Partial<FolderWorkspace> = {}): FolderWorkspace => ({
  id: 'folder-1',
  projectGroupId: 'group-1',
  name: 'Workspace',
  folderPath: '/workspace',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  createdAt: 0,
  lastActivityAt: 0,
  updatedAt: 0,
  ...patch
})
const repo = (patch: Partial<Repo> = {}): Repo => ({
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0,
  ...patch
})
const projectGroup = (patch: Partial<ProjectGroup> = {}): ProjectGroup => ({
  id: 'group-1',
  name: 'Group',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch
})
const state = (patch: Partial<FolderWorkspaceHostState> = {}): FolderWorkspaceHostState => ({
  folderWorkspaces: [folder()],
  projectGroups: [],
  repos: [],
  ...patch
})

describe('verified local folder workspace keys', () => {
  it.each([undefined, null, 'local'] as const)('accepts local ownership %s', (executionHostId) => {
    expect(
      getVerifiedLocalFolderWorkspaceKeys(
        state({
          folderWorkspaces: [folder({ executionHostId })]
        })
      )
    ).toEqual(new Set(['folder:folder-1']))
  })

  it.each(['ssh:target-1', 'runtime:environment-1', 'invalid', ''])(
    'rejects nonlocal or invalid ownership %s',
    (executionHostId) => {
      expect(
        getVerifiedLocalFolderWorkspaceKeys(
          state({
            folderWorkspaces: [
              // Why Object.assign: invalid stored ids must reach the parser without widening the type.
              Object.assign(folder(), { executionHostId })
            ]
          })
        )
      ).toEqual(new Set())
    }
  )

  it('honors explicit local ownership over legacy scope', () => {
    expect(
      getVerifiedLocalFolderWorkspaceKeys(
        state({
          folderWorkspaces: [folder({ executionHostId: 'local', connectionId: 'target-1' })],
          repos: [repo({ executionHostId: 'runtime:environment-1' })]
        })
      )
    ).toEqual(new Set(['folder:folder-1']))
  })

  it.each([
    state({ folderWorkspaces: [] }),
    state({ folderWorkspaces: [folder(), folder()] }),
    state({
      folderWorkspaces: [
        folder({ executionHostId: 'local' }),
        folder({ executionHostId: 'runtime:environment-1' })
      ]
    }),
    state({ folderWorkspaces: [folder({ connectionId: 'target-1' })] }),
    state({ projectGroups: [projectGroup({ connectionId: 'target-1' })] }),
    state({ repos: [repo({ executionHostId: 'runtime:environment-1' })] }),
    state({ repos: [repo({ executionHostId: 'ssh:target-1' })] }),
    state({ repos: [repo(), repo({ id: 'repo-2', connectionId: 'target-1' })] }),
    state({ repos: [repo(), repo({ id: 'repo-2', executionHostId: 'runtime:environment-1' })] })
  ])('rejects missing, duplicate, remote, or ambiguous scope %#', (catalog) => {
    expect(getVerifiedLocalFolderWorkspaceKeys(catalog)).toEqual(new Set())
  })

  it('accepts local inferred scope without unrelated runtime repos affecting it', () => {
    expect(
      getVerifiedLocalFolderWorkspaceKeys(
        state({
          repos: [
            repo(),
            repo({ id: 'remote', path: '/elsewhere', executionHostId: 'runtime:environment-1' })
          ]
        })
      )
    ).toEqual(new Set(['folder:folder-1']))
  })
})
