import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prepareMock, registerMock, createMock } = vi.hoisted(() => ({
  prepareMock: vi.fn(),
  registerMock: vi.fn(),
  createMock: vi.fn()
}))

vi.mock('../github/stacked-pr-creation', () => ({
  prepareGitHubStackedPullRequest: prepareMock,
  registerGitHubStackedPullRequest: registerMock
}))

vi.mock('./hosted-review-creation', () => ({ createHostedReview: createMock }))

import { createStackedHostedReview } from './stacked-hosted-review-creation'

const input = {
  provider: 'github' as const,
  base: 'stack/parent',
  head: 'stack/child',
  title: 'Child'
}
const repository = { owner: 'acme', repo: 'orca', host: 'github.com' }
const parentReview = { number: 41, url: 'https://github.com/acme/orca/pull/41' }
const currentReview = { number: 42, url: 'https://github.com/acme/orca/pull/42' }

beforeEach(() => {
  prepareMock.mockReset()
  registerMock.mockReset()
  createMock.mockReset()
})

describe('createStackedHostedReview', () => {
  it('creates the current PR before registering the stack', async () => {
    prepareMock.mockResolvedValue({
      ok: true,
      repository,
      parentReview,
      currentReview: null
    })
    createMock.mockResolvedValue({ ok: true, ...currentReview })
    registerMock.mockResolvedValue({
      ok: true,
      ...currentReview,
      parentReview,
      stackNumber: 50
    })

    const result = await createStackedHostedReview('/repo', input, 'ssh:ssh-1')

    expect(result).toMatchObject({ ok: true, stackNumber: 50 })
    expect(createMock).toHaveBeenCalledWith('/repo', input, 'ssh:ssh-1', {})
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentReview, currentReview, executionHostId: 'ssh:ssh-1' })
    )
  })

  it('retries registration without creating a duplicate PR', async () => {
    prepareMock.mockResolvedValue({
      ok: true,
      repository,
      parentReview,
      currentReview
    })
    registerMock.mockResolvedValue({
      ok: true,
      ...currentReview,
      parentReview,
      stackNumber: 50
    })

    await createStackedHostedReview('/repo', input, 'local')

    expect(createMock).not.toHaveBeenCalled()
    expect(registerMock).toHaveBeenCalledOnce()
  })

  it('does not create a PR when the parent topology is invalid', async () => {
    prepareMock.mockResolvedValue({
      ok: false,
      code: 'validation',
      error: 'Choose the top pull request.'
    })

    const result = await createStackedHostedReview('/repo', input, 'local')

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    expect(createMock).not.toHaveBeenCalled()
    expect(registerMock).not.toHaveBeenCalled()
  })
})
