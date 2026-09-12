import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectGroup } from '../../../src/shared/project-groups'
import { getProjectGroupHeaderKey } from '../../../src/shared/project-groups'
import { collapseWorkspaceListSections } from './workspace-list-collapse'
import {
  buildRepoProjectGroupIdByRepoId,
  readProjectGroupListResult
} from './mobile-project-groups'
import { buildSections, type Worktree } from './workspace-list-sections'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', overrides.displayName ?? 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: overrides.worktreeId ?? `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('mobile workspace list project-group pipeline', () => {
  const work = createProjectGroup({ name: 'Work', createdFrom: 'manual', tabOrder: 0 })
  const clients = createProjectGroup({
    name: 'Clients',
    createdFrom: 'manual',
    tabOrder: 0,
    parentGroupId: work.id
  })

  const repoList = {
    repos: [
      { id: 'repo-1', displayName: 'orca', projectGroupId: work.id },
      { id: 'repo-2', displayName: 'client', projectGroupId: clients.id },
      { id: 'repo-3', displayName: 'notes' }
    ]
  }
  const groupList = { groups: [work, clients] }

  it('projects repo.list + projectGroup.list + worktree.ps into the desktop nest and collapse keys', () => {
    const projectGroups = readProjectGroupListResult(groupList)
    const repoProjectGroupIdByRepoId = buildRepoProjectGroupIdByRepoId(repoList.repos)
    const worktrees = [
      worktree({
        worktreeId: 'orca-main',
        repoId: 'repo-1',
        repo: 'orca',
        displayName: 'main',
        isMainWorktree: true
      }),
      worktree({
        worktreeId: 'client-feat',
        repoId: 'repo-2',
        repo: 'client',
        displayName: 'feat'
      }),
      worktree({
        worktreeId: 'notes-main',
        repoId: 'repo-3',
        repo: 'notes',
        displayName: 'notes'
      })
    ]

    const raw = buildSections(
      worktrees,
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'repo',
      new Set(),
      new Map(repoList.repos.map((repo) => [repo.displayName, repo.id])),
      [],
      new Set(),
      projectGroups,
      repoProjectGroupIdByRepoId
    )

    expect(
      raw.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        depth: section.depth
      }))
    ).toEqual([
      {
        key: getProjectGroupHeaderKey(work.id),
        title: 'Work',
        kind: 'project-group',
        depth: 0
      },
      { key: 'repo:repo-1', title: 'orca', kind: 'repo', depth: 1 },
      {
        key: getProjectGroupHeaderKey(clients.id),
        title: 'Clients',
        kind: 'project-group',
        depth: 1
      },
      { key: 'repo:repo-2', title: 'client', kind: 'repo', depth: 2 },
      { key: 'repo:repo-3', title: 'notes', kind: 'repo', depth: 0 }
    ])
    expect(
      raw.find((section) => section.key === 'repo:repo-1')?.data.map((row) => row.worktreeId)
    ).toEqual(['orca-main'])

    const collapsed = collapseWorkspaceListSections(
      raw,
      new Set([getProjectGroupHeaderKey(work.id)])
    )
    expect(collapsed.map((section) => section.key)).toEqual([
      getProjectGroupHeaderKey(work.id),
      'repo:repo-3'
    ])
    expect(collapsed.flatMap((section) => section.data.map((row) => row.worktreeId))).toEqual([
      'notes-main'
    ])
  })

  it('does not nest project groups outside repo grouping', () => {
    const sections = buildSections(
      [worktree({ worktreeId: 'orca-main', repoId: 'repo-1', repo: 'orca' })],
      'manual',
      { filterRepoIds: new Set(), hideSleeping: false, hideDefaultBranch: false },
      '',
      'none',
      new Set(),
      new Map([['orca', 'repo-1']]),
      [],
      new Set(),
      readProjectGroupListResult(groupList),
      buildRepoProjectGroupIdByRepoId(repoList.repos)
    )
    expect(sections.map((section) => section.key)).toEqual(['all'])
  })
})
