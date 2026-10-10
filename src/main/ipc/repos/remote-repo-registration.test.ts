// Registration is now the runtime's SSH path too (`projectHostSetup.setupExistingFolder --host
// ssh:*`), so what it stamps decides what every downstream host resolver can read. It minted
// `connectionId`-only rows, leaving the unified spelling permanently empty, and deduped by raw
// `connectionId`, which cannot see a row stamped `executionHostId: 'ssh:*'`.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn(async () => ({}))
}))

vi.mock('../../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: vi.fn(() => null)
}))

vi.mock('./remote-home-path', () => ({
  resolveRemoteHomePath: vi.fn(async (_connectionId: string, path: string) => path)
}))

import { addRemoteRepoFromPath } from './remote-repo-registration'

function makeStore(repos: Repo[]) {
  return {
    getRepos: () => repos,
    getSshTarget: () => undefined,
    addRepo: (repo: Repo) => {
      repos.push(repo)
    }
  }
}

describe('addRemoteRepoFromPath', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    getSshGitProviderMock.mockReturnValue({
      isGitRepoAsync: vi.fn(async () => ({ isRepo: true, rootPath: '/srv/app' }))
    })
  })

  it('stamps the unified execution-host spelling alongside the legacy connection id', async () => {
    const repos: Repo[] = []
    const result = await addRemoteRepoFromPath(makeStore(repos) as never, {
      connectionId: 'm4air',
      remotePath: '/srv/app'
    })

    expect('error' in result).toBe(false)
    const repo = (result as { repo: Repo }).repo
    expect(repo.connectionId).toBe('m4air')
    expect(repo.executionHostId).toBe('ssh:m4air')
  })

  it('dedupes against a row that names the host in the unified spelling only', async () => {
    const existing = {
      id: 'existing',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: 'ssh:m4air'
    } as Repo
    const repos: Repo[] = [existing]

    const result = await addRemoteRepoFromPath(makeStore(repos) as never, {
      connectionId: 'm4air',
      remotePath: '/srv/app'
    })

    expect(result).toEqual({ repo: existing, alreadyExisted: true })
    expect(repos).toHaveLength(1)
  })

  it('does not dedupe onto a row on a different SSH host at the same path', async () => {
    // Two hosts can both hold /srv/app. Matching on path alone registers one host's repo as the
    // other's — the mirror image of the id-only lookup this change removes.
    const repos: Repo[] = [
      {
        id: 'openclaw-row',
        path: '/srv/app',
        displayName: 'app',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'openclaw'
      } as Repo
    ]

    const result = await addRemoteRepoFromPath(makeStore(repos) as never, {
      connectionId: 'm4air',
      remotePath: '/srv/app'
    })

    expect((result as { alreadyExisted: boolean }).alreadyExisted).toBe(false)
    expect((result as { repo: Repo }).repo.executionHostId).toBe('ssh:m4air')
    expect(repos).toHaveLength(2)
  })

  it('does not dedupe onto a local row that carries a stale connection id', async () => {
    // The pullfrog case: a row declaring itself local must not answer as an SSH host.
    const repos: Repo[] = [
      {
        id: 'local-row',
        path: '/srv/app',
        displayName: 'app',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'local',
        connectionId: 'develop'
      } as Repo
    ]

    const result = await addRemoteRepoFromPath(makeStore(repos) as never, {
      connectionId: 'develop',
      remotePath: '/srv/app'
    })

    expect((result as { alreadyExisted: boolean }).alreadyExisted).toBe(false)
    expect(repos).toHaveLength(2)
  })
})
