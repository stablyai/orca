import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetProjectRefCache,
  getIssueProjectRef,
  getProjectRef,
  resolveIssueSource
} from './gitlab-project-ref-resolution'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('gitlab project ref resolution (live git)', () => {
  let repoPath = ''

  beforeEach(async () => {
    _resetProjectRefCache()
    repoPath = await mkdtemp(join(tmpdir(), 'orca-gitlab-ref-'))
    git(repoPath, ['init'])
  })

  afterEach(async () => {
    _resetProjectRefCache()
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('resolves Issues project ref when the only remote is not named origin/upstream', async () => {
    git(repoPath, [
      'remote',
      'add',
      'myremote',
      'ssh://git@gitlab.example.com:2222/group/project.git'
    ])

    await expect(getIssueProjectRef(repoPath, ['gitlab.example.com'])).resolves.toEqual({
      host: 'gitlab.example.com',
      path: 'group/project'
    })
    await expect(getProjectRef(repoPath, ['gitlab.example.com'])).resolves.toEqual({
      host: 'gitlab.example.com',
      path: 'group/project'
    })
    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.example.com'])).resolves.toEqual({
      source: { host: 'gitlab.example.com', path: 'group/project' },
      fellBack: false
    })
  })

  it('prefers upstream over origin and over custom remotes in a fork layout', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'git@gitlab.com:fork/orca.git'])
    git(repoPath, ['remote', 'add', 'upstream', 'git@gitlab.com:parent/orca.git'])
    git(repoPath, ['remote', 'add', 'aaa', 'git@gitlab.com:custom/aaa.git'])

    await expect(getIssueProjectRef(repoPath)).resolves.toEqual({
      host: 'gitlab.com',
      path: 'parent/orca'
    })
  })

  it('breaks ties among custom GitLab remotes by remote name', async () => {
    git(repoPath, ['remote', 'add', 'zebra', 'git@gitlab.com:team/zebra.git'])
    git(repoPath, ['remote', 'add', 'alpha', 'git@gitlab.com:team/alpha.git'])

    await expect(getIssueProjectRef(repoPath)).resolves.toEqual({
      host: 'gitlab.com',
      path: 'team/alpha'
    })
  })

  it('ignores non-GitLab remotes while matching a known self-hosted host', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'git@github.com:user/fork.git'])
    git(repoPath, [
      'remote',
      'add',
      'gitlab-work',
      'https://gitlab.example.com:8443/group/project.git'
    ])

    await expect(getIssueProjectRef(repoPath, ['gitlab.example.com:8443'])).resolves.toEqual({
      host: 'gitlab.example.com:8443',
      path: 'group/project'
    })
  })

  it('returns null before fix-equivalent path when remotes only have non-matching hosts', async () => {
    git(repoPath, ['remote', 'add', 'myremote', 'git@github.com:user/fork.git'])

    await expect(getIssueProjectRef(repoPath, ['gitlab.example.com'])).resolves.toBeNull()
  })
})
