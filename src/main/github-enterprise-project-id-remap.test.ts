import { describe, expect, it } from 'vitest'
import type { PersistedState, Project, ProjectHostSetup, Repo, WorktreeMeta } from '../shared/types'
import { remapHostLessGitHubEnterpriseProjectIds } from './github-enterprise-project-id-remap'

const NOW = 1_700_000_000_000
const GHES_PROJECT_ID = 'github:git.acme-corp.com/acme/orca'
const HOST_LESS_PROJECT_ID = 'github:acme/orca'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-ghes',
    path: '/work/orca',
    displayName: 'orca',
    badgeColor: '#737373',
    addedAt: NOW,
    kind: 'git',
    upstream: { owner: 'acme', repo: 'orca', host: 'git.acme-corp.com' },
    ...overrides
  }
}

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    ...overrides
  }
}

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    repos: [makeRepo()],
    projects: [],
    projectHostSetups: [],
    worktreeMeta: {
      'repo-ghes::/work/orca-feature': makeWorktreeMeta({
        projectId: HOST_LESS_PROJECT_ID,
        projectHostSetupId: `${HOST_LESS_PROJECT_ID}::local`
      })
    },
    ...overrides
  } as PersistedState
}

describe('remapHostLessGitHubEnterpriseProjectIds', () => {
  it('moves host-less worktree meta onto the one Enterprise id it can have meant', () => {
    const { state, changed } = remapHostLessGitHubEnterpriseProjectIds(makeState())

    expect(changed).toBe(true)
    expect(state.worktreeMeta['repo-ghes::/work/orca-feature']).toMatchObject({
      projectId: GHES_PROJECT_ID,
      projectHostSetupId: `${GHES_PROJECT_ID}::local`
    })
  })

  it('is idempotent, so it can run on every load', () => {
    const first = remapHostLessGitHubEnterpriseProjectIds(makeState())

    const second = remapHostLessGitHubEnterpriseProjectIds(first.state)

    expect(second.changed).toBe(false)
    expect(second.state).toBe(first.state)
  })

  it('leaves genuine github.com references alone', () => {
    const state = makeState({
      repos: [makeRepo({ upstream: { owner: 'acme', repo: 'orca' } })]
    })

    const result = remapHostLessGitHubEnterpriseProjectIds(state)

    expect(result.changed).toBe(false)
    expect(result.state.worktreeMeta['repo-ghes::/work/orca-feature']?.projectId).toBe(
      HOST_LESS_PROJECT_ID
    )
  })

  it('leaves the id alone when a github.com repo still owns it', () => {
    const state = makeState({
      repos: [
        makeRepo(),
        makeRepo({ id: 'repo-dotcom', upstream: { owner: 'acme', repo: 'orca' } })
      ]
    })

    const result = remapHostLessGitHubEnterpriseProjectIds(state)

    expect(result.changed).toBe(false)
  })

  it('leaves the id alone when two Enterprise hosts serve the same slug', () => {
    const state = makeState({
      repos: [
        makeRepo(),
        makeRepo({
          id: 'repo-ghes-b',
          upstream: { owner: 'acme', repo: 'orca', host: 'git.other-corp.com' }
        })
      ]
    })

    const result = remapHostLessGitHubEnterpriseProjectIds(state)

    expect(result.changed).toBe(false)
  })

  it('re-keys persisted project rows and their host setups', () => {
    const project: Project = {
      id: HOST_LESS_PROJECT_ID,
      displayName: 'orca',
      badgeColor: '#737373',
      sourceRepoIds: ['repo-ghes'],
      createdAt: NOW,
      updatedAt: NOW
    }
    const setup = {
      id: `${HOST_LESS_PROJECT_ID}::ssh:builder`,
      projectId: HOST_LESS_PROJECT_ID
    } as ProjectHostSetup
    const state = makeState({ projects: [project], projectHostSetups: [setup] })

    const result = remapHostLessGitHubEnterpriseProjectIds(state)

    expect(result.state.projects[0]?.id).toBe(GHES_PROJECT_ID)
    expect(result.state.projectHostSetups[0]).toMatchObject({
      id: `${GHES_PROJECT_ID}::ssh:builder`,
      projectId: GHES_PROJECT_ID
    })
  })

  it('ignores generic git and repo-keyed references', () => {
    const state = makeState({
      worktreeMeta: {
        'repo-ghes::/work/orca-feature': makeWorktreeMeta({
          projectId: 'git:gitlab.example.com/team/orca',
          projectHostSetupId: 'git:gitlab.example.com/team/orca::local'
        })
      }
    })

    const result = remapHostLessGitHubEnterpriseProjectIds(state)

    expect(result.changed).toBe(false)
  })
})
