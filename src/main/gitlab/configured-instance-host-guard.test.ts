import { afterEach, describe, expect, it } from 'vitest'
import { setConfiguredGitLabUrl } from './gitlab-known-host-probe'
import {
  assertConfiguredGitLabHost,
  assertConfiguredProjectRef,
  resolveConfiguredGitLabHost
} from './configured-instance-host-guard'

afterEach(() => {
  setConfiguredGitLabUrl('')
})

describe('configured GitLab instance host guard', () => {
  it('rejects every supplied host when no instance is configured', () => {
    setConfiguredGitLabUrl('')

    expect(resolveConfiguredGitLabHost('gitlab.com')).toEqual({
      ok: false,
      reason: 'no GitLab instance is configured'
    })
    expect(() => assertConfiguredGitLabHost('gitlab.com')).toThrow(
      'no GitLab instance is configured'
    )
  })

  it('rejects a host that is not the configured instance', () => {
    setConfiguredGitLabUrl('https://gitlab.example.com')

    expect(() => assertConfiguredGitLabHost('gitlab.evil.test')).toThrow('does not match')
    // A same-name host on another port is a different endpoint.
    expect(() => assertConfiguredGitLabHost('gitlab.example.com:8080')).toThrow('does not match')
    expect(() => assertConfiguredGitLabHost(null)).toThrow('does not match')
  })

  it('canonicalizes a matching host and project ref', () => {
    setConfiguredGitLabUrl('https://GitLab.Example.com/')

    expect(assertConfiguredGitLabHost(' GITLAB.example.COM ')).toBe('gitlab.example.com')
    expect(assertConfiguredProjectRef({ host: 'GitLab.Example.com', path: 'g/p' })).toEqual({
      host: 'gitlab.example.com',
      path: 'g/p'
    })
  })

  it('passes an absent project ref through so callers keep the resolved-remote path', () => {
    setConfiguredGitLabUrl('https://gitlab.example.com')

    expect(assertConfiguredProjectRef(null)).toBeNull()
    expect(assertConfiguredProjectRef(undefined)).toBeUndefined()
  })
})
