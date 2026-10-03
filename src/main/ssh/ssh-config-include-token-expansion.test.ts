import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandIncludeTokens, type IncludePathContext } from './ssh-config-include-path-resolution'

function makeContext(overrides: Partial<IncludePathContext> = {}): IncludePathContext {
  return {
    home: '/home/testuser',
    pathApi: posix,
    rootDir: '/home/testuser/.ssh',
    shortHostname: 'workstation',
    uid: '1001',
    username: 'testuser',
    ...overrides
  }
}

describe('expandIncludeTokens', () => {
  it('expands %u and %i from the local identity', () => {
    expect(expandIncludeTokens('%u/%i.conf', makeContext())).toBe('testuser/1001.conf')
  })

  it.each([
    ['%u', 'username', { username: '' }],
    ['%i', 'uid', { uid: undefined }]
  ] as const)(
    'leaves %s unresolved when the %s is unknown, rather than expanding to an empty segment',
    (token, _label, overrides) => {
      expect(expandIncludeTokens(`${token}/.conf`, makeContext(overrides))).toBeNull()
    }
  )
})
