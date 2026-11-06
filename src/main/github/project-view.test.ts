import { describe, expect, it } from 'vitest'
import {
  GITHUB_PROJECT_REF_INPUT_MAX_BYTES,
  GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR
} from '../../shared/github/project-ref-input'
import {
  _getProjectViewCacheSizesForTests,
  _getProjectViewOwnerTypeForTests,
  _hasProjectViewParentFieldRetriedForTests,
  _hasProjectViewParentFieldWarningLoggedForTests,
  _markProjectViewParentFieldRetriedForTests,
  _markProjectViewParentFieldWarningLoggedForTests,
  _rememberProjectViewOwnerTypeForTests,
  _resetProjectViewCachesForTests,
  parseProjectPaste,
  resolveProjectRef
} from './project-view'

describe('parseProjectPaste', () => {
  it('accepts enterprise-host URLs only when that host is provided (GHES)', () => {
    const url = 'https://github.corp.example/orgs/acme/projects/7/views/2'
    expect(parseProjectPaste(url, 'github.corp.example')).toEqual({
      kind: 'org',
      owner: 'acme',
      number: 7,
      host: 'github.corp.example',
      viewNumber: 2
    })
    expect(parseProjectPaste(url)).toBeNull()
    expect(
      parseProjectPaste('https://github.com/orgs/acme/projects/7', 'github.corp.example')
    ).toEqual({ kind: 'org', owner: 'acme', number: 7, host: 'github.com' })
  })

  it('rejects credentials and paths that only begin like a Project URL', () => {
    expect(parseProjectPaste('https://user:token@github.com/orgs/acme/projects/1')).toBeNull()
    expect(parseProjectPaste('https://github.com/orgs/acme/projects/1evil')).toBeNull()
    expect(parseProjectPaste('https://github.com/orgs/acme/projects/1/views/2evil')).toBeNull()
    expect(parseProjectPaste('https://github.com/orgs/acme/projects/1/files')).toBeNull()
  })
})

describe('resolveProjectRef', () => {
  it('rejects oversized project refs with a metadata-only validation error', async () => {
    const secret = 'project-url-secret'
    const input = [
      'https://github.com/orgs/acme/projects/42?',
      secret,
      'x'.repeat(GITHUB_PROJECT_REF_INPUT_MAX_BYTES)
    ].join('')

    await expect(resolveProjectRef({ input })).resolves.toEqual({
      ok: false,
      error: {
        type: 'validation_error',
        message: GITHUB_PROJECT_REF_INPUT_TOO_LARGE_ERROR,
        reason: 'input_too_large'
      }
    })
    await expect(resolveProjectRef({ input })).resolves.not.toMatchObject({
      error: { message: expect.stringContaining(secret) }
    })
  })
})
