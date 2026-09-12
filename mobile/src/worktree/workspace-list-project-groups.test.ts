import { describe, expect, it } from 'vitest'
import { createProjectGroup, getProjectGroupHeaderKey } from '../../../src/shared/project-groups'
import { nestRepoSectionsInProjectGroups } from './workspace-list-project-groups'
import type { Section, Worktree } from './workspace-list-types'

function repoSection(repoId: string, title: string): Section {
  return {
    key: `repo:${repoId}`,
    title,
    kind: 'repo',
    depth: 0,
    count: 1,
    data: [{ worktreeId: repoId, repoId, repo: title } as Worktree]
  }
}

describe('nestRepoSectionsInProjectGroups', () => {
  const work = createProjectGroup({ name: 'Work', createdFrom: 'manual', tabOrder: 0 })
  const clients = createProjectGroup({
    name: 'Clients',
    createdFrom: 'manual',
    tabOrder: 0,
    parentGroupId: work.id
  })
  const personal = createProjectGroup({ name: 'Personal', createdFrom: 'manual', tabOrder: 1 })

  it('keeps a flat repo list when the host has no project groups', () => {
    const sections = nestRepoSectionsInProjectGroups({
      repoSections: [repoSection('repo-1', 'orca')],
      projectGroups: [],
      repoProjectGroupIdByRepoId: new Map([['repo-1', 'missing']])
    })
    expect(sections.map((section) => section.key)).toEqual(['repo:repo-1'])
    expect(sections[0]?.depth).toBe(0)
  })

  it('nests repos under desktop project-group keys and leaves ungrouped repos at the root', () => {
    const sections = nestRepoSectionsInProjectGroups({
      repoSections: [
        repoSection('repo-1', 'orca'),
        repoSection('repo-2', 'notes'),
        repoSection('repo-3', 'client')
      ],
      projectGroups: [work, clients, personal],
      repoProjectGroupIdByRepoId: new Map([
        ['repo-1', work.id],
        ['repo-2', personal.id],
        ['repo-3', clients.id]
      ])
    })

    expect(
      sections.map((section) => ({
        key: section.key,
        title: section.title,
        kind: section.kind,
        depth: section.depth,
        count: section.count
      }))
    ).toEqual([
      {
        key: getProjectGroupHeaderKey(work.id),
        title: 'Work',
        kind: 'project-group',
        depth: 0,
        count: 2
      },
      { key: 'repo:repo-1', title: 'orca', kind: 'repo', depth: 1, count: 1 },
      {
        key: getProjectGroupHeaderKey(clients.id),
        title: 'Clients',
        kind: 'project-group',
        depth: 1,
        count: 1
      },
      { key: 'repo:repo-3', title: 'client', kind: 'repo', depth: 2, count: 1 },
      {
        key: getProjectGroupHeaderKey(personal.id),
        title: 'Personal',
        kind: 'project-group',
        depth: 0,
        count: 1
      },
      { key: 'repo:repo-2', title: 'notes', kind: 'repo', depth: 1, count: 1 }
    ])
  })

  it('shows empty project groups and treats unknown membership as ungrouped', () => {
    const empty = createProjectGroup({ name: 'Empty', createdFrom: 'manual', tabOrder: 2 })
    const sections = nestRepoSectionsInProjectGroups({
      repoSections: [repoSection('repo-1', 'orca')],
      projectGroups: [work, empty],
      repoProjectGroupIdByRepoId: new Map([['repo-1', 'ghost-group']])
    })

    expect(sections.map((section) => section.key)).toEqual([
      getProjectGroupHeaderKey(work.id),
      getProjectGroupHeaderKey(empty.id),
      'repo:repo-1'
    ])
    expect(sections[2]?.depth).toBe(0)
  })
})
