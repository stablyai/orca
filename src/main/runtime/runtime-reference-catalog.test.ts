import { describe, expect, it } from 'vitest'
import {
  listReferenceWorkspaces,
  listWorkspaceReferences,
  selectReferenceWorkspace
} from './runtime-reference-catalog'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../shared/worktree/meta-persisted-defaults'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const repo: Repo = { id: 'repo', path: '/repo', displayName: 'api', badgeColor: '', addedAt: 0 }
const meta: WorktreeMeta = {
  ...WORKTREE_META_PERSISTED_DEFAULTS,
  displayName: 'api',
  linkedPR: 5123,
  comment: '',
  isUnread: false,
  sortOrder: 0,
  lastActivityAt: 0
}
const id = 'repo::/repo'

function catalog(metadata: Record<string, WorktreeMeta> = { [id]: meta }) {
  return listReferenceWorkspaces({ getRepos: () => [repo], getAllWorktreeMeta: () => metadata })
}

describe('reference metadata catalog', () => {
  it('exposes old scalar links without a scan', () => {
    const rows = catalog()
    expect(rows[0].linkedItems).toEqual([{ provider: 'github', type: 'pr', number: 5123 }])
    expect(listWorkspaceReferences(rows[0]).references[0]).toMatchObject({
      selected: true,
      number: 5123
    })
  })
  it('finds the closest local workspace only for explicit current', () => {
    const rows = catalog({ [id]: meta, 'repo::/repo/child': { ...meta, displayName: 'child' } })
    expect(selectReferenceWorkspace(rows, 'current', '/repo/child/src').name).toBe('child')
    expect(() => selectReferenceWorkspace(rows, 'current')).toThrow('working directory')
    expect(() => selectReferenceWorkspace(rows, 'current', '/repository')).toThrow(
      'selector_not_found'
    )
  })
  it('includes discovered workspaces before their first metadata write', () => {
    const [worktree] = catalog()
    const rows = listReferenceWorkspaces(
      { getRepos: () => [repo], getAllWorktreeMeta: () => ({}) },
      [worktree]
    )
    expect(rows).toHaveLength(1)
    expect(selectReferenceWorkspace(rows, `id:${id}`).id).toBe(id)
  })
  it('resolves explicit WSL paths only with the caller distro evidence', () => {
    const [row] = catalog()
    const ubuntu = { ...row, path: '//wsl$/Ubuntu/home/me/api' }
    const debian = { ...row, id: 'repo::debian', path: '//wsl$/Debian/home/me/api' }
    expect(
      selectReferenceWorkspace([ubuntu, debian], 'path:/home/me/api', '//wsl$/Ubuntu/home/me').id
    ).toBe(row.id)
    expect(() => selectReferenceWorkspace([ubuntu, debian], 'path:/home/me/api')).toThrow(
      'selector_not_found'
    )
    expect(() =>
      selectReferenceWorkspace([ubuntu], 'path:/home/me/api', '//wsl$/Debian/home/me')
    ).toThrow('selector_not_found')
  })
  it('retains same-id rows on separate hosts and refuses an ambiguous id', () => {
    const rows = listReferenceWorkspaces({
      getRepos: () => [repo, { ...repo, connectionId: 'server' }],
      getAllWorktreeMeta: () => ({}),
      getAllWorktreeMetaForHost: (hostId) => ({ [id]: { ...meta, hostId } })
    })
    expect(rows.map((row) => row.hostId)).toEqual(['local', 'ssh:server'])
    expect(() => selectReferenceWorkspace(rows, `id:${id}`)).toThrow('selector_ambiguous')
    expect(selectReferenceWorkspace(rows, 'current', '/repo').hostId).toBe('local')
  })
  it('collapses duplicate same-host path registrations but not cross-host ones', () => {
    const [row] = catalog()
    const duplicate = { ...row, id: 'repo-copy::/repo' }
    expect(selectReferenceWorkspace([row, duplicate], `path:${row.path}`).id).toBe(row.id)
    expect(selectReferenceWorkspace([row, duplicate], 'current', '/repo/src').id).toBe(row.id)
    expect(() =>
      selectReferenceWorkspace([row, { ...duplicate, hostId: 'ssh:build' }], `path:${row.path}`)
    ).toThrow('selector_ambiguous')
  })
  it('does not match issue:null against unlinked workspaces', () => {
    const [row] = catalog()
    expect(() => selectReferenceWorkspace([row], 'issue:null')).toThrow('selector_not_found')
    expect(selectReferenceWorkspace([{ ...row, linkedIssue: 42 }], 'issue:42').id).toBe(row.id)
  })
  it('does not attribute unqualified legacy metadata to colliding hosts', () => {
    const rows = listReferenceWorkspaces({
      getRepos: () => [repo, { ...repo, connectionId: 'server' }],
      getAllWorktreeMeta: () => ({ [id]: meta })
    })
    expect(rows).toEqual([])
  })
  it('uses folder storage and exposes selected legacy tasks', () => {
    const rows = listReferenceWorkspaces({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [
        {
          id: 'notes',
          projectGroupId: 'group',
          name: 'notes',
          folderPath: 'C:\\notes',
          linkedTask: {
            provider: 'linear',
            type: 'issue',
            number: 0,
            title: 'Task',
            url: 'https://linear.app/acme/issue/STA-1234',
            linearIdentifier: 'STA-1234'
          },
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })
    expect(selectReferenceWorkspace(rows, 'path:C:/notes')).toMatchObject({
      id: 'folder:notes',
      kind: 'folder'
    })
    expect(listWorkspaceReferences(rows[0]).references).toEqual([
      expect.objectContaining({ selected: true, identifier: 'STA-1234' })
    ])
  })
})
