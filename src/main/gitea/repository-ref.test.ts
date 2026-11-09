import { describe, expect, it } from 'vitest'
import { parseGiteaRepoRef } from './repository-ref'

describe('Gitea repository ownership', () => {
  it.each([
    'git@ssh.github.com:team/repo.git',
    'ssh://git@altssh.gitlab.com:443/team/repo.git',
    'https://acme.ghe.com/team/repo.git'
  ])('does not claim a canonical public forge: %s', (remote) => {
    expect(parseGiteaRepoRef(remote)).toBeNull()
  })

  it.each(['https://codeberg.org/team/repo.git', 'https://git.acme.test/team/repo.git'])(
    'keeps Gitea endpoints available: %s',
    (remote) => {
      expect(parseGiteaRepoRef(remote)).toMatchObject({ owner: 'team', repo: 'repo' })
    }
  )
})
