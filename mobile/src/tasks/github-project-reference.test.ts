import { describe, expect, it } from 'vitest'
import { parseGitHubProjectInput } from './github-project-reference'

describe('parseGitHubProjectInput', () => {
  it('keeps legacy owner/number input hostless', () => {
    expect(parseGitHubProjectInput('Acme/42')).toEqual({ owner: 'Acme', number: 42 })
  })

  it('preserves GitHub Enterprise hosts and view numbers', () => {
    expect(
      parseGitHubProjectInput('https://GitHub.Acme-Corp.com:8443/orgs/Acme/projects/42/views/7')
    ).toEqual({
      owner: 'Acme',
      number: 42,
      host: 'github.acme-corp.com:8443',
      viewNumber: 7
    })
  })

  it('accepts github.com user Project URLs', () => {
    expect(parseGitHubProjectInput('http://github.com/users/octocat/projects/3')).toEqual({
      owner: 'octocat',
      number: 3,
      host: 'github.com'
    })
  })

  it('rejects credentials, invalid routes, and unsafe integers', () => {
    for (const input of [
      'https://user:token@github.acme.test/orgs/acme/projects/1',
      'https://github.acme.test/acme/projects/1',
      'https://github.acme.test/orgs/acme/projects/1/files',
      'https://github.acme.test/orgs/acme/projects/9007199254740992',
      'https://github.acme.test/orgs/acme/projects/1/views/0'
    ]) {
      expect(parseGitHubProjectInput(input)).toBeNull()
    }
  })
})
