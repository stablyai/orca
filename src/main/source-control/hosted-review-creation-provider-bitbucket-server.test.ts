import { beforeEach, describe, expect, it, vi } from 'vitest'

const { cloudAuthMock, serverAuthMock, serverRepoRefMock } = vi.hoisted(() => ({
  cloudAuthMock: vi.fn(),
  serverAuthMock: vi.fn(),
  serverRepoRefMock: vi.fn()
}))

vi.mock('../bitbucket/pull-request-creation', () => ({
  isBitbucketReviewCreationAuthenticated: cloudAuthMock
}))
vi.mock('../bitbucket/server-pull-request-creation', () => ({
  isBitbucketServerReviewCreationAuthenticated: serverAuthMock
}))
vi.mock('../bitbucket/server-repository-ref', () => ({
  getBitbucketServerRepoRef: serverRepoRefMock
}))

import { isProviderAuthenticated } from './hosted-review-creation-provider'

describe('Bitbucket review creation auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the server credential for a server repo', async () => {
    serverRepoRefMock.mockResolvedValue({
      baseUrl: 'https://b.example.com',
      projectKey: 'p',
      repoSlug: 'r'
    })
    serverAuthMock.mockReturnValue(true)
    cloudAuthMock.mockReturnValue(false)

    await expect(isProviderAuthenticated('bitbucket', '/repo', 'local')).resolves.toBe(true)
    expect(cloudAuthMock).not.toHaveBeenCalled()
  })

  it('keeps the cloud check for a cloud repo', async () => {
    serverRepoRefMock.mockResolvedValue(null)
    serverAuthMock.mockReturnValue(true)
    cloudAuthMock.mockReturnValue(false)

    await expect(isProviderAuthenticated('bitbucket', '/repo', 'local')).resolves.toBe(false)
  })
})
