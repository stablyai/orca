import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../shared/types'
import { gitExecFileAsync } from './git/runner'
import { enrichMissingRepoGitRemoteIdentities } from './repo-git-remote-identity-enrichment'

const tempDirs: string[] = []

async function makeTempRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-identity-'))
  tempDirs.push(dir)
  return dir
}

function makeStore(repo: Repo): {
  getRepos: () => Repo[]
  updateRepo: (id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>) => Repo | null
} {
  const repos = [repo]
  return {
    getRepos: () => repos,
    updateRepo: (id, updates) => {
      const target = repos.find((candidate) => candidate.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, updates)
      return target
    }
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('enrichMissingRepoGitRemoteIdentities', () => {
  it('backfills a missing git remote identity from local git metadata', async () => {
    const repoPath = await makeTempRepoDir()
    await gitExecFileAsync(['init'], { cwd: repoPath })
    await gitExecFileAsync(
      ['remote', 'add', 'origin', 'git@git.company.test:team/sample-app.git'],
      { cwd: repoPath }
    )
    const repo: Repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'sample-app',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git'
    }
    const store = makeStore(repo)

    await expect(enrichMissingRepoGitRemoteIdentities(store)).resolves.toBe(true)
    expect(repo.gitRemoteIdentity).toEqual({
      canonicalKey: 'git.company.test/team/sample-app',
      remoteName: 'origin',
      remoteUrl: 'git@git.company.test:team/sample-app.git'
    })
  })
})
