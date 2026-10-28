import { describe, expect, it } from 'vitest'
import { mapBitbucketRepository } from './repository-list'

describe('mapBitbucketRepository', () => {
  it('strips the caller username from HTTPS clone links', () => {
    expect(
      mapBitbucketRepository({
        full_name: 'acme/api',
        name: 'api',
        is_private: true,
        updated_on: '2026-10-01T00:00:00Z',
        links: {
          clone: [
            { name: 'https', href: 'https://jdoe@bitbucket.org/acme/api.git' },
            { name: 'ssh', href: 'git@bitbucket.org:acme/api.git' }
          ]
        }
      })
    ).toEqual({
      fullName: 'acme/api',
      name: 'api',
      isPrivate: true,
      updatedOn: '2026-10-01T00:00:00Z',
      httpsCloneUrl: 'https://bitbucket.org/acme/api.git',
      sshCloneUrl: 'git@bitbucket.org:acme/api.git'
    })
  })

  it('clones over SSH through bitbucket.org, the host users have trusted', () => {
    const mapped = (href: string) =>
      mapBitbucketRepository({ full_name: 'acme/api', links: { clone: [{ name: 'ssh', href }] } })
        ?.sshCloneUrl
    expect(mapped('git@ssh.bitbucket.org:acme/api.git')).toBe('git@bitbucket.org:acme/api.git')
    expect(mapped('ssh://git@ssh.bitbucket.org/acme/api.git')).toBe(
      'ssh://git@bitbucket.org/acme/api.git'
    )
    expect(mapped('git@ssh.bitbucket.org.evil.example:acme/api.git')).toBe(
      'git@ssh.bitbucket.org.evil.example:acme/api.git'
    )
  })

  it('drops repositories that cannot be cloned', () => {
    expect(mapBitbucketRepository({ full_name: 'acme/api', links: { clone: [] } })).toBeNull()
    expect(mapBitbucketRepository({ name: 'api' })).toBeNull()
  })
})
