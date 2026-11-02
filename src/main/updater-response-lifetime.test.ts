import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from './lib/unread-response-body.test-fixtures'

const { fetchMock, resolveTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolveTokenMock: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: fetchMock, request: vi.fn() } }))
vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: resolveTokenMock,
  rejectReleaseApiToken: vi.fn()
}))
vi.mock('./git/gh-rate-limit-breaker', () => ({
  getGhRateLimitBlockedUntilMs: () => null,
  recordGhPrimaryRateLimit: vi.fn()
}))

import { fetchChangelog } from './updater-changelog'
import { fetchNudge } from './updater-nudge'
import { fetchNewerReleaseTagsWithReadiness } from './updater-prerelease-feed'
import { listReleaseBuilds } from './updater-release-builds'

describe('updater response ownership', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveTokenMock.mockReset().mockResolvedValue(null)
  })

  it.each([
    { name: 'nudge', read: () => fetchNudge() },
    { name: 'changelog', read: () => fetchChangelog('1.2.4', '1.2.3') }
  ])('releases rejected $name response bodies', async ({ read }) => {
    const cancel = vi.fn()
    const response = cancelTrackingResponse(503, cancel)
    fetchMock.mockResolvedValue(response)
    try {
      await expect(read()).resolves.toBeNull()
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await response.body?.cancel()
    }
  })

  it('releases a rejected release feed', async () => {
    const cancel = vi.fn()
    const response = cancelTrackingResponse(503, cancel)
    fetchMock.mockResolvedValue(response)
    try {
      await expect(fetchNewerReleaseTagsWithReadiness('1.2.3', 1)).resolves.toEqual({
        tags: [],
        state: 'unavailable',
        unavailableReason: 'feed'
      })
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await response.body?.cancel()
    }
  })

  it.each([404, 503])('releases a rejected manifest with HTTP %s', async (status) => {
    const cancel = vi.fn()
    const response = cancelTrackingResponse(status, cancel)
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          '<feed><link href="https://github.com/stablyai/orca/releases/tag/v1.2.4"/></feed>'
        )
      )
      .mockResolvedValueOnce(response)
    try {
      const result = await fetchNewerReleaseTagsWithReadiness('1.2.3', 1)
      expect(result.state).toBe(status === 404 ? 'not-ready' : 'unavailable')
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await response.body?.cancel()
    }
  })

  it('preserves release-list errors when body cancellation rejects', async () => {
    const cancel = vi.fn(() => {
      throw new Error('stream failed')
    })
    const response = cancelTrackingResponse(503, cancel)
    fetchMock.mockResolvedValue(response)
    try {
      await expect(listReleaseBuilds('stable')).rejects.toThrow('HTTP 503')
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      await response.body?.cancel().catch(() => {})
    }
  })

  it.each([401, 403])(
    'releases the HTTP %s body before retrying without a token',
    async (status) => {
      resolveTokenMock.mockResolvedValue({ token: 'fixture-token', rateLimitScope: 'fixture' })
      const cancel = vi.fn()
      const response = cancelTrackingResponse(status, cancel)
      if (status === 403) {
        response.headers.set('x-ratelimit-remaining', '0')
      }
      fetchMock.mockResolvedValueOnce(response).mockImplementationOnce(() => {
        expect(cancel).toHaveBeenCalledOnce()
        return Promise.resolve(Response.json([]))
      })
      try {
        await expect(listReleaseBuilds('stable')).resolves.toEqual([])
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        await response.body?.cancel()
      }
    }
  )
})
