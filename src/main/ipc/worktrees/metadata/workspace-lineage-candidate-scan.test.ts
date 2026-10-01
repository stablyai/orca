import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { createLineageResolutionContext } from './lineage-owner-resolution'
import { getFolderLineageCandidateRepos } from './workspace-lineage-filtering'

vi.mock('../../worktree-logic', () => ({ parseWorktreeId: vi.fn() }))

function repo(id: string, fields: Partial<Repo> = {}): Repo {
  return { id, path: `/root/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...fields }
}

function group(id = 'group', fields: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}

function folder(fields: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder',
    projectGroupId: 'group',
    name: 'folder',
    folderPath: '/root',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...fields
  }
}

function context(repos: Repo[], groups = [group()]) {
  const store = {
    getRepos: () => repos,
    getFolderWorkspaces: () => [],
    getProjectGroups: () => groups
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Context construction only reads these three store catalogs.
  return createLineageResolutionContext(store as never)
}

describe('folder lineage candidate lookup', () => {
  it('reads grouped target membership once across a large path-candidate list', () => {
    let targetReads = 0
    const grouped = Array.from({ length: 300 }, (_, index): Repo => ({
      ...repo(`grouped-${index}`, { projectGroupId: 'group', path: `/elsewhere/${index}` }),
      get connectionId() {
        targetReads += 1
        return null
      }
    }))
    const candidates = Array.from({ length: 1_000 }, (_, index) => repo(`path-${index}`))
    const result = getFolderLineageCandidateRepos(context([...grouped, ...candidates]), folder())

    expect(result).toEqual([...grouped, ...candidates])
    expect(targetReads).toBe(300)
  })

  it('preserves descendant-group priority, path boundaries and local/SSH membership', () => {
    const entries = [
      repo('path-a', { connectionId: 'a' }),
      repo('group-b', { projectGroupId: 'nested', path: '/elsewhere', connectionId: 'b' }),
      repo('local-null', { connectionId: null }),
      repo('group-local', { projectGroupId: 'group' }),
      repo('path-b', { connectionId: 'b' }),
      repo('local-absent'),
      repo('sibling', { path: '/root-other/repo', connectionId: 'b' }),
      repo('root', { path: '/root', connectionId: 'b' })
    ]
    const snapshot = structuredClone(entries)
    const result = getFolderLineageCandidateRepos(
      context(entries, [group(), group('nested', { parentGroupId: 'group' })]),
      folder()
    )

    expect(result.map((entry) => entry.id)).toEqual([
      'group-b',
      'group-local',
      'local-null',
      'path-b',
      'local-absent',
      'root'
    ])
    expect(result[0]).toBe(entries[1])
    expect(entries).toEqual(snapshot)
  })

  it.each([
    { folderTarget: 'a', groupTarget: 'b', expected: ['grouped', 'a'] },
    { folderTarget: null, groupTarget: 'b', expected: ['grouped', 'b'] },
    { folderTarget: undefined, groupTarget: undefined, expected: ['grouped', 'local'] }
  ])(
    'keeps explicit target precedence: $folderTarget / $groupTarget',
    ({ folderTarget, groupTarget, expected }) => {
      const entries = [
        repo('a', { connectionId: 'a' }),
        repo('b', { connectionId: 'b' }),
        repo('local'),
        repo('grouped', { projectGroupId: 'group', path: '/outside' })
      ]
      expect(
        getFolderLineageCandidateRepos(
          context(entries, [group('group', { connectionId: groupTarget })]),
          folder({ connectionId: folderTarget })
        ).map((entry) => entry.id)
      ).toEqual(expected)
    }
  )

  it('keeps every contained target when the folder has no grouped repositories', () => {
    const entries = [
      repo('local'),
      repo('remote', { connectionId: 'a' }),
      repo('outside', { path: '/elsewhere' })
    ]
    expect(getFolderLineageCandidateRepos(context(entries), folder())).toEqual(entries.slice(0, 2))
  })

  it('does not read grouped targets when there are no path candidates', () => {
    let targetReads = 0
    const grouped: Repo = {
      ...repo('grouped', { projectGroupId: 'group' }),
      get connectionId() {
        targetReads += 1
        return 'a'
      }
    }
    expect(getFolderLineageCandidateRepos(context([grouped]), folder())).toEqual([grouped])
    expect(targetReads).toBe(0)
  })

  it('rebuilds target membership after a later change in the same context', () => {
    const grouped = repo('grouped', { projectGroupId: 'group', connectionId: 'a' })
    const a = repo('a', { connectionId: 'a' })
    const b = repo('b', { connectionId: 'b' })
    const current = context([grouped, a, b])
    expect(getFolderLineageCandidateRepos(current, folder())).toEqual([grouped, a])
    grouped.connectionId = 'b'
    expect(getFolderLineageCandidateRepos(current, folder())).toEqual([grouped, b])
  })
})
