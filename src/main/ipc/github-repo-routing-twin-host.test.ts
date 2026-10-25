import { describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGhExecOptions: () => ({})
}))

import {
  assertRegisteredGitHubRepo,
  assertRegisteredPRRefreshCandidateRepo,
  validateAutomaticPRRefreshCandidate
} from './github-repo-routing'

const localTwin: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1
}
const sshTwin: Repo = { ...localTwin, path: '/remote/twin', connectionId: 'builder' }
const samePathSshTwin: Repo = { ...sshTwin, path: localTwin.path }

function storeWith(repos: Repo[]): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getRepos.
  return { getRepos: () => repos } as unknown as Store
}

function candidate(overrides: Partial<GitHubPRRefreshCandidate>): GitHubPRRefreshCandidate {
  return {
    cacheKey: 'twin::branch',
    repoPath: sshTwin.path,
    branch: 'feature',
    repoKind: 'git',
    repoId: 'twin',
    connectionId: 'builder',
    ...overrides
  }
}

describe('registered GitHub repo lookup for a repo id on two hosts', () => {
  it("accepts the second twin's fetch by its own path", () => {
    const store = storeWith([localTwin, sshTwin])

    expect(assertRegisteredGitHubRepo({ repoPath: '/remote/twin', repoId: 'twin' }, store)).toBe(
      sshTwin
    )
    expect(assertRegisteredGitHubRepo({ repoPath: '/laptop/twin', repoId: 'twin' }, store)).toBe(
      localTwin
    )
  })

  it("queues the SSH twin's PR refresh on the SSH row, even when it is listed second", () => {
    const result = validateAutomaticPRRefreshCandidate(
      candidate({}),
      storeWith([localTwin, sshTwin])
    )

    expect(result).toMatchObject({
      kind: 'ok',
      candidate: { repoPath: '/remote/twin', connectionId: 'builder' }
    })
  })

  it('picks the candidate host when the twins share a path', () => {
    const store = storeWith([localTwin, samePathSshTwin])

    expect(
      validateAutomaticPRRefreshCandidate(candidate({ repoPath: localTwin.path }), store)
    ).toMatchObject({ kind: 'ok', candidate: { connectionId: 'builder' } })
    expect(
      validateAutomaticPRRefreshCandidate(
        candidate({ repoPath: localTwin.path, connectionId: null }),
        store
      )
    ).toMatchObject({ kind: 'ok', candidate: { connectionId: null } })
  })

  it('resolves a manual PR refresh to the same twin as the automatic queue', () => {
    const store = storeWith([localTwin, samePathSshTwin])

    expect(
      assertRegisteredPRRefreshCandidateRepo(candidate({ repoPath: localTwin.path }), store)
    ).toBe(samePathSshTwin)
  })

  it("keeps a lone row's own host over a stale candidate host", () => {
    const result = validateAutomaticPRRefreshCandidate(
      candidate({ repoPath: localTwin.path, connectionId: 'gone' }),
      storeWith([localTwin])
    )

    expect(result).toMatchObject({ kind: 'ok', candidate: { connectionId: null } })
  })

  it('still refuses a path that no row with that id holds', () => {
    expect(() =>
      assertRegisteredGitHubRepo(
        { repoPath: '/elsewhere', repoId: 'twin' },
        storeWith([localTwin, sshTwin])
      )
    ).toThrow('repository path does not match repo id')
  })
})
