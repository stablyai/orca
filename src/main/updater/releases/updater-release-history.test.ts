import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
// No gh login: list anonymously so no subprocess is spawned.
vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: vi.fn().mockResolvedValue(null),
  rejectReleaseApiToken: vi.fn()
}))

import { fetchReleaseHistory } from './updater-release-history'

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-11-16T10:30:50Z',
    html_url: `https://github.com/stablyai/orca/releases/tag/${tag}`,
    body: `Notes for ${tag}`,
    ...extra
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

beforeEach(() => {
  netFetchMock.mockReset()
})

describe('fetchReleaseHistory', () => {
  it('lists stable releases after the installed build up to the update, newest first', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse([
        release('v1.4.263'),
        release('v1.4.262-rc.1', { prerelease: true }),
        release('v1.4.262', { draft: true }),
        release('v1.4.261'),
        release('v1.4.260-rc.2'),
        release('v1.4.259'),
        release('v1.4.258'),
        release('v1.4.257')
      ])
    )

    const history = await fetchReleaseHistory('1.4.261', '1.4.258+custom.1')

    expect(history).toEqual({
      installedVersion: '1.4.258+custom.1',
      newerReleaseCount: 2,
      releases: [
        {
          version: '1.4.261',
          publishedAt: '2026-11-16T10:30:50Z',
          notes: 'Notes for v1.4.261',
          releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.261'
        },
        {
          version: '1.4.259',
          publishedAt: '2026-11-16T10:30:50Z',
          notes: 'Notes for v1.4.259',
          releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.259'
        }
      ]
    })
  })

  it('reads further pages until it reaches the installed build, capping the notes it returns', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => release(`v1.5.${99 - index}`))
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([release('v1.4.1'), release('v1.4.0')]))

    const history = await fetchReleaseHistory('1.5.99', '1.4.0')

    expect(history?.newerReleaseCount).toBe(101)
    expect(history?.releases).toHaveLength(25)
    expect(history?.releases[0].version).toBe('1.5.99')
  })

  it('keeps reading pages past an older release listed before newer ones', async () => {
    // A maintenance release cut after newer ones sorts first in GitHub's creation-date order.
    const firstPage = [
      release('v1.3.9'),
      ...Array.from({ length: 99 }, (_, index) => release(`v1.0.${index}`))
    ]
    netFetchMock
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([release('v1.4.2'), release('v1.4.1')]))

    const history = await fetchReleaseHistory('1.4.2', '1.4.0')

    expect(history?.releases.map((entry) => entry.version)).toEqual(['1.4.2', '1.4.1'])
  })

  it('falls back when the list cannot be fetched, and retries on the next check', async () => {
    netFetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 403 }))
      .mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
      .mockResolvedValueOnce(jsonResponse([release('v1.3.11'), release('v1.3.10')]))

    expect(await fetchReleaseHistory('1.3.11', '1.3.10')).toBeNull()
    expect(await fetchReleaseHistory('1.3.11', '1.3.10')).toBeNull()
    const history = await fetchReleaseHistory('1.3.11', '1.3.10')
    expect(history?.releases.map((entry) => entry.version)).toEqual(['1.3.11'])
  })

  it('reuses the listed history for the same update', async () => {
    netFetchMock
      .mockResolvedValueOnce(jsonResponse([release('v1.2.6'), release('v1.2.5')]))
      .mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'))

    await fetchReleaseHistory('1.2.6', '1.2.5')
    const history = await fetchReleaseHistory('1.2.6', '1.2.5')

    expect(history?.releases.map((entry) => entry.version)).toEqual(['1.2.6'])
  })
})
