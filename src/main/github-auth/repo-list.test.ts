import { describe, expect, it } from 'vitest'
import { mapRepoPayload } from './repo-list'

const basePayload = {
  id: 123,
  name: 'orca',
  full_name: 'acme/orca',
  description: 'Workspace manager',
  private: true,
  fork: false,
  html_url: 'https://github.com/acme/orca',
  clone_url: 'https://github.com/acme/orca.git',
  ssh_url: 'git@github.com:acme/orca.git',
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 42,
  pushed_at: '2026-08-20T10:00:00Z',
  owner: { login: 'acme', avatar_url: 'https://avatars.githubusercontent.com/u/1' }
}

describe('mapRepoPayload', () => {
  it('maps a full REST payload onto the panel shape', () => {
    expect(mapRepoPayload(basePayload)).toEqual({
      id: 123,
      name: 'orca',
      fullName: 'acme/orca',
      description: 'Workspace manager',
      isPrivate: true,
      isFork: false,
      htmlUrl: 'https://github.com/acme/orca',
      cloneUrl: 'https://github.com/acme/orca.git',
      sshUrl: 'git@github.com:acme/orca.git',
      defaultBranch: 'main',
      language: 'TypeScript',
      stargazersCount: 42,
      pushedAt: '2026-08-20T10:00:00Z',
      ownerLogin: 'acme',
      ownerAvatarUrl: 'https://avatars.githubusercontent.com/u/1'
    })
  })

  it('drops entries too incomplete to clone or display', () => {
    expect(mapRepoPayload({ ...basePayload, clone_url: null })).toBeNull()
    expect(mapRepoPayload({ ...basePayload, full_name: 42 })).toBeNull()
    expect(mapRepoPayload({ ...basePayload, owner: null })).toBeNull()
    expect(mapRepoPayload({ ...basePayload, id: 'x' })).toBeNull()
  })

  it('defaults optional fields defensively', () => {
    expect(
      mapRepoPayload({
        ...basePayload,
        description: null,
        language: null,
        stargazers_count: undefined,
        pushed_at: null,
        private: undefined,
        fork: undefined,
        html_url: undefined,
        ssh_url: undefined,
        default_branch: undefined,
        owner: { login: 'acme' }
      })
    ).toMatchObject({
      description: null,
      language: null,
      stargazersCount: 0,
      pushedAt: null,
      isPrivate: false,
      isFork: false,
      htmlUrl: 'https://github.com/acme/orca',
      sshUrl: 'git@github.com:acme/orca.git',
      defaultBranch: 'main',
      ownerAvatarUrl: null
    })
  })
})
