import { describe, expect, it } from 'vitest'
import {
  giteaHostFromInstanceUrl,
  parseGtLoginStatus,
  parseGtVersion
} from './gitea-known-host-probe'

describe('parseGtLoginStatus', () => {
  it('maps `gt auth status --json` rows to known logins', () => {
    const stdout = JSON.stringify([
      { active: true, host: 'git.example.com', user: 'ada', credential_available: true },
      { active: false, host: 'https://other.dev:3000/gitea', user: 'bob' },
      { error: 'no host' }
    ])
    expect(parseGtLoginStatus(stdout)).toEqual([
      {
        name: 'ada@git.example.com',
        url: 'https://git.example.com',
        host: 'git.example.com',
        sshHost: 'git.example.com',
        user: 'ada',
        isDefault: true
      },
      {
        name: 'bob@other.dev:3000/gitea',
        url: 'https://other.dev:3000/gitea',
        host: 'other.dev:3000/gitea',
        sshHost: 'other.dev:3000',
        user: 'bob',
        isDefault: false
      }
    ])
  })

  it('returns no logins for invalid output', () => {
    expect(parseGtLoginStatus('not json')).toEqual([])
    expect(parseGtLoginStatus('{}')).toEqual([])
  })
})

describe('gt helpers', () => {
  it('parses the version line', () => {
    expect(
      parseGtVersion('gt version 2.0.0\nhttps://gitea.com/gitea/cli/releases/tag/v2.0.0')
    ).toBe('2.0.0')
    expect(parseGtVersion('nope')).toBeNull()
  })

  it('keeps ports and subpaths in the host key', () => {
    expect(giteaHostFromInstanceUrl('https://Git.Example.com:8443/sub/')).toBe(
      'git.example.com:8443/sub'
    )
  })
})
