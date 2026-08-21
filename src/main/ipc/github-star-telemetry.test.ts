import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const { getAuthenticatedViewer: getAuthenticatedViewerMock, starMCode: starMCodeMock } = mocks.client
const { track: trackMock } = mocks.telemetry
const { getCohortAtEmit: getCohortAtEmitMock } = mocks.cohort

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('forwards the authenticated viewer lookup', async () => {
    getAuthenticatedViewerMock.mockResolvedValue({ login: 'octocat', email: 'octocat@example.com' })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:viewer'](null, undefined)).resolves.toEqual({
      login: 'octocat',
      email: 'octocat@example.com'
    })
    expect(getAuthenticatedViewerMock).toHaveBeenCalled()
  })

  it('emits app_starred_mcode once after a successful star with cohort context', async () => {
    starMCodeMock.mockResolvedValue(true)
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 3 })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starMCode'](null, 'settings')).resolves.toBe(true)

    expect(starMCodeMock).toHaveBeenCalledTimes(1)
    expect(getCohortAtEmitMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('app_starred_mcode', {
      source: 'settings',
      nth_repo_added: 3
    })
  })

  it('accepts every app star source for success telemetry', async () => {
    starMCodeMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    for (const source of [
      'star_nag',
      'agent_value_moment',
      'onboarding_completed',
      'settings',
      'landing'
    ] as const) {
      await expect(handlers['gh:starMCode'](null, source)).resolves.toBe(true)
    }

    expect(trackMock).toHaveBeenCalledTimes(5)
    expect(trackMock.mock.calls.map(([, props]) => props)).toEqual([
      { source: 'star_nag', nth_repo_added: undefined },
      { source: 'agent_value_moment', nth_repo_added: undefined },
      { source: 'onboarding_completed', nth_repo_added: undefined },
      { source: 'settings', nth_repo_added: undefined },
      { source: 'landing', nth_repo_added: undefined }
    ])
  })

  it('does not emit app_starred_mcode when the star action returns false', async () => {
    starMCodeMock.mockResolvedValue(false)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starMCode'](null, 'landing')).resolves.toBe(false)

    expect(starMCodeMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('does not emit app_starred_mcode when the star action throws', async () => {
    starMCodeMock.mockRejectedValue(new Error('gh failed'))

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starMCode'](null, 'star_nag')).rejects.toThrow('gh failed')

    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('preserves star result but skips telemetry for an invalid IPC source', async () => {
    starMCodeMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starMCode'](null, 'github_website')).resolves.toBe(true)

    expect(starMCodeMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })
})
