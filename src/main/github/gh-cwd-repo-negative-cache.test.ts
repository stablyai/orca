import { afterEach, describe, expect, it, vi } from 'vitest'

const { readLocalGitConfigSignatureMock } = vi.hoisted(() => ({
  readLocalGitConfigSignatureMock: vi.fn()
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import {
  _resetGhCwdRepoNegativeCache,
  getRememberedGhCwdResolutionFailure,
  isGhCwdRepoResolutionFailure,
  rememberGhCwdResolutionFailure
} from './gh-cwd-repo-negative-cache'

const context = { repoPath: '/repo', connectionId: null }

afterEach(() => {
  _resetGhCwdRepoNegativeCache()
  readLocalGitConfigSignatureMock.mockReset()
})

describe('isGhCwdRepoResolutionFailure', () => {
  it('matches gh cwd-resolution failures only', () => {
    expect(isGhCwdRepoResolutionFailure('Command failed: gh\nno git remotes found')).toBe(true)
    expect(
      isGhCwdRepoResolutionFailure(
        'none of the git remotes configured for this repository point to a known GitHub host'
      )
    ).toBe(true)
    expect(isGhCwdRepoResolutionFailure('gh: API rate limit exceeded (HTTP 403)')).toBe(false)
    expect(isGhCwdRepoResolutionFailure('gh: Not Found (HTTP 404)')).toBe(false)
  })
})

describe('remembered failures', () => {
  it('serves the remembered failure while the config signature is unchanged', async () => {
    readLocalGitConfigSignatureMock.mockResolvedValue('sig-1')
    await rememberGhCwdResolutionFailure(context, 'no git remotes found')
    await expect(getRememberedGhCwdResolutionFailure(context)).resolves.toBe('no git remotes found')
  })

  it('invalidates when the git config signature changes (remote added)', async () => {
    readLocalGitConfigSignatureMock.mockResolvedValueOnce('sig-1')
    await rememberGhCwdResolutionFailure(context, 'no git remotes found')
    readLocalGitConfigSignatureMock.mockResolvedValue('sig-2')
    await expect(getRememberedGhCwdResolutionFailure(context)).resolves.toBeNull()
    // The stale entry is gone, not just skipped.
    readLocalGitConfigSignatureMock.mockResolvedValue('sig-1')
    await expect(getRememberedGhCwdResolutionFailure(context)).resolves.toBeNull()
  })

  it('separates repos and runtimes by cache key', async () => {
    readLocalGitConfigSignatureMock.mockResolvedValue('sig')
    await rememberGhCwdResolutionFailure(context, 'no git remotes found')
    await expect(
      getRememberedGhCwdResolutionFailure({ repoPath: '/other-repo', connectionId: null })
    ).resolves.toBeNull()
    await expect(
      getRememberedGhCwdResolutionFailure({ repoPath: '/repo', connectionId: 'ssh-1' })
    ).resolves.toBeNull()
  })
})
