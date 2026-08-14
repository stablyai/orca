import { describe, expect, it } from 'vitest'
import type { Repo, WorktreeMeta } from '../../shared/types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree-id'
import {
  getRuntimeFolderWorkspaceInstanceId,
  getRuntimeFolderWorkspaceRootId,
  isRuntimeFolderWorkspaceIdForRepo,
  mergeRuntimeFolderWorkspace
} from './runtime-folder-workspace'

// characterization: current behavior

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/Users/dev/projects/site',
    displayName: 'site',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('getRuntimeFolderWorkspaceRootId', () => {
  it.each([
    { label: 'posix path', input: repo(), expected: 'repo-1::/Users/dev/projects/site' },
    {
      label: 'windows path',
      input: repo({ path: 'C:\\Users\\dev\\site' }),
      expected: 'repo-1::C:\\Users\\dev\\site'
    },
    {
      label: 'ssh repo (connectionId is not part of the id)',
      input: repo({ connectionId: 'ssh-1', path: '/home/dev/site' }),
      expected: 'repo-1::/home/dev/site'
    },
    { label: 'empty path', input: repo({ path: '' }), expected: 'repo-1::' }
  ])('joins repo id and path for $label', ({ input, expected }) => {
    expect(getRuntimeFolderWorkspaceRootId(input)).toBe(expected)
  })
})

describe('getRuntimeFolderWorkspaceInstanceId', () => {
  it('appends the instance id after the separator', () => {
    expect(getRuntimeFolderWorkspaceInstanceId(repo(), 'abc')).toBe(
      `repo-1::/Users/dev/projects/site${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}abc`
    )
  })

  it('appends an empty instance id without complaint', () => {
    expect(getRuntimeFolderWorkspaceInstanceId(repo(), '')).toBe(
      `repo-1::/Users/dev/projects/site${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
    )
  })
})

describe('isRuntimeFolderWorkspaceIdForRepo', () => {
  const root = 'repo-1::/Users/dev/projects/site'

  it.each([
    { label: 'the root id itself', worktreeId: root, expected: true },
    {
      label: 'an instance id under the root',
      worktreeId: `${root}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}abc`,
      expected: true
    },
    {
      label: 'a sibling path that merely shares the root as a prefix',
      worktreeId: `${root}-other`,
      expected: false
    },
    { label: 'another repo', worktreeId: 'repo-2::/Users/dev/projects/site', expected: false },
    { label: 'an unrelated id', worktreeId: '', expected: false }
  ])('$label', ({ worktreeId, expected }) => {
    expect(isRuntimeFolderWorkspaceIdForRepo(repo(), worktreeId)).toBe(expected)
  })
})

describe('mergeRuntimeFolderWorkspace', () => {
  it('projects repo + meta onto a branchless, headless worktree', () => {
    const merged = mergeRuntimeFolderWorkspace(repo(), 'repo-1::/Users/dev/projects/site', meta())

    expect(merged).toEqual({
      id: 'repo-1::/Users/dev/projects/site',
      repoId: 'repo-1',
      path: '/Users/dev/projects/site',
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: true,
      displayName: 'site',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      linkedWorkItem: null,
      linkedTaskSourceContext: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'in-progress',
      diffComments: undefined,
      mobileDiffReview: undefined
    })
  })

  it('marks a non-root id as a secondary workspace', () => {
    const worktreeId = `repo-1::/Users/dev/projects/site${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}abc`
    const merged = mergeRuntimeFolderWorkspace(repo(), worktreeId, meta({ instanceId: 'abc' }))

    expect(merged.isMainWorktree).toBe(false)
    expect(merged.instanceId).toBe('abc')
    expect(merged.path).toBe('/Users/dev/projects/site')
  })

  it('falls back to the repo display name when meta has a blank one', () => {
    expect(mergeRuntimeFolderWorkspace(repo(), 'id', meta()).displayName).toBe('site')
    expect(
      mergeRuntimeFolderWorkspace(repo(), 'id', meta({ displayName: 'custom' })).displayName
    ).toBe('custom')
  })

  it('omits optional keys rather than writing undefined for them', () => {
    const merged = mergeRuntimeFolderWorkspace(repo(), 'id', meta())

    expect('instanceId' in merged).toBe(false)
    expect('projectId' in merged).toBe(false)
    expect('hostId' in merged).toBe(false)
    expect('projectHostSetupId' in merged).toBe(false)
    expect('manualOrder' in merged).toBe(false)
    expect('createdAt' in merged).toBe(false)
    expect('createdWithAgent' in merged).toBe(false)
    expect('automationProvenance' in merged).toBe(false)
    expect('cliProvenance' in merged).toBe(false)
    expect('priorWorktreeIds' in merged).toBe(false)
  })

  it('carries project-first ownership fields through when present', () => {
    const merged = mergeRuntimeFolderWorkspace(
      repo(),
      'id',
      meta({
        projectId: 'project-1',
        hostId: 'local',
        projectHostSetupId: 'setup-1',
        manualOrder: 3,
        createdAt: 42,
        priorWorktreeIds: ['old-id']
      })
    )

    expect(merged.projectId).toBe('project-1')
    expect(merged.hostId).toBe('local')
    expect(merged.projectHostSetupId).toBe('setup-1')
    expect(merged.manualOrder).toBe(3)
    expect(merged.createdAt).toBe(42)
    expect(merged.priorWorktreeIds).toEqual(['old-id'])
  })

  it('keeps an explicit workspace status instead of the default', () => {
    expect(
      mergeRuntimeFolderWorkspace(repo(), 'id', meta({ workspaceStatus: 'done' })).workspaceStatus
    ).toBe('done')
  })
})
