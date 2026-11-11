import { expect, it } from 'vitest'
import { parseGiteaRepoRef } from './repository-ref'

it('keeps Gitea endpoints available without claiming canonical foreign hosts', () => {
  for (const remote of [
    'git@ssh.github.com:team/repo.git',
    'ssh://git@altssh.gitlab.com:443/team/repo.git',
    'https://acme.ghe.com/team/repo.git'
  ]) {
    expect(parseGiteaRepoRef(remote)).toBeNull()
  }
  expect(parseGiteaRepoRef('https://codeberg.org/team/repo.git')).toMatchObject({
    owner: 'team',
    repo: 'repo'
  })
  expect(parseGiteaRepoRef('https://git.acme.test/team/repo.git')).toMatchObject({
    owner: 'team',
    repo: 'repo'
  })
})
