import { describe, expect, it } from 'vitest'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from './new-workspace-dialog-repo-selection'

type Repo = {
  id: string
  path: string
  connectionId?: string | null
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    ...overrides
  }
}

describe('mobile new workspace dialog repo selection', () => {
  it('matches the dialog repo priority order', () => {
    const eligibleRepos = [
      makeRepo('first'),
      makeRepo('active'),
      makeRepo('initial'),
      makeRepo('draft')
    ]

    expect(
      resolveMobileNewWorkspaceDialogRepoId({
        eligibleRepos,
        draftRepoId: 'draft',
        initialRepoId: 'initial',
        activeRepoId: 'active'
      })
    ).toBe('draft')
  })

  it('uses the last visited repo as the active repo before falling back', () => {
    const eligibleRepos = [makeRepo('first'), makeRepo('active')]

    expect(resolveMobileNewWorkspaceDialogRepoId({ eligibleRepos, activeRepoId: 'active' })).toBe(
      'active'
    )
    expect(resolveMobileNewWorkspaceDialogRepoId({ eligibleRepos, activeRepoId: 'missing' })).toBe(
      'first'
    )
  })

  it('defaults to a repo on the focused host when no explicit repo is chosen', () => {
    const eligibleRepos = [
      makeRepo('local-repo'),
      makeRepo('ssh-repo', { connectionId: 'win-vm' }),
      makeRepo('runtime-repo', { executionHostId: 'runtime:env-1' })
    ]

    expect(
      resolveMobileNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'ssh:win-vm' })
    ).toBe('ssh-repo')
    expect(
      resolveMobileNewWorkspaceDialogRepoId({
        eligibleRepos,
        focusedHostScope: 'runtime:env-1'
      })
    ).toBe('runtime-repo')
    expect(
      resolveMobileNewWorkspaceDialogRepoId({ eligibleRepos, focusedHostScope: 'local' })
    ).toBe('local-repo')
  })

  it('excludes repos without paths from dialog defaults', () => {
    expect(
      getMobileNewWorkspaceDialogEligibleRepos([
        makeRepo('missing-path', { path: '' }),
        makeRepo('repo')
      ])
    ).toEqual([expect.objectContaining({ id: 'repo' })])
  })

  it('refreshes the selected repo from the fresh repo list', () => {
    const staleSelectedRepo = makeRepo('repo', { path: '/cached/repo' })
    const freshRepo = makeRepo('repo', { path: '/fresh/repo' })

    expect(refreshMobileNewWorkspaceDialogSelectedRepo([freshRepo], staleSelectedRepo)).toBe(
      freshRepo
    )
  })

  it('clears a cached selected repo that is missing from the fresh repo list', () => {
    expect(
      refreshMobileNewWorkspaceDialogSelectedRepo([makeRepo('fresh')], makeRepo('stale'))
    ).toBe(null)
  })
})
