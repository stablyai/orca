import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))

const { listReleaseBuilds, resolveTargetBuild } = await import('./updater-release-builds')

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body)
  }
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: '2026-07-28T14:00:00Z',
  html_url: `https://github.com/stablyai/orca/releases/tag/${tag}`,
  ...extra
})

describe('listReleaseBuilds', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('lists hourly builds from the dedicated repo, newest first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.160-hourly.202607280900'),
        release('v1.4.160-hourly.202607281400'),
        release('v1.4.160-hourly.202607281000')
      ])
    )

    const builds = await listReleaseBuilds('hourly')

    expect(fetchMock.mock.calls[0][0]).toContain('stablyai/orca-hourly')
    expect(builds.map((build) => build.version)).toEqual([
      '1.4.160-hourly.202607281400',
      '1.4.160-hourly.202607281000',
      '1.4.160-hourly.202607280900'
    ])
  })

  // Why: the main repo serves stable and rc from one endpoint, so an unfiltered
  // list would offer RC tags under the Stable channel.
  it('separates stable from rc in the shared main repo', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([release('v1.4.160-rc.2'), release('v1.4.159'), release('v1.4.158')])
    )

    await expect(listReleaseBuilds('stable').then((b) => b.map((x) => x.version))).resolves.toEqual(
      ['1.4.159', '1.4.158']
    )

    fetchMock.mockResolvedValue(
      jsonResponse([release('v1.4.160-rc.2'), release('v1.4.159'), release('v1.4.158')])
    )
    await expect(listReleaseBuilds('rc').then((b) => b.map((x) => x.version))).resolves.toEqual([
      '1.4.160-rc.2'
    ])
  })

  // Why: a draft release has no downloadable assets; offering it makes the
  // switch action fail with a 404 after the user commits to it.
  it('skips drafts and unparseable tags', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.159'),
        release('v1.4.158', { draft: true }),
        release('not-a-version'),
        { tag_name: 42 }
      ])
    )

    const builds = await listReleaseBuilds('stable')
    expect(builds.map((build) => build.version)).toEqual(['1.4.159'])
  })

  it('surfaces a rate limit as an actionable message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 403 }))
    await expect(listReleaseBuilds('hourly')).rejects.toThrow(/rate limit/i)
  })

  it('reports a missing hourly repo distinctly', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }))
    await expect(listReleaseBuilds('hourly')).rejects.toThrow(/No releases repository/i)
  })
})

describe('resolveTargetBuild', () => {
  it('pins an hourly tag at the hourly repo download path', () => {
    expect(resolveTargetBuild('hourly', 'v1.4.160-hourly.202607281400')).toEqual({
      tag: 'v1.4.160-hourly.202607281400',
      version: '1.4.160-hourly.202607281400',
      feedUrl:
        'https://github.com/stablyai/orca-hourly/releases/download/v1.4.160-hourly.202607281400'
    })
  })

  it('pins a stable tag at the main repo download path', () => {
    expect(resolveTargetBuild('stable', 'v1.4.159').feedUrl).toBe(
      'https://github.com/stablyai/orca/releases/download/v1.4.159'
    )
  })

  it('rejects a tag that is not a version', () => {
    expect(() => resolveTargetBuild('stable', 'main')).toThrow(/not a valid release tag/)
  })
})
