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

  it('lists daily builds from the dedicated repo, newest first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.160-daily.202607271300'),
        release('v1.4.160-daily.202607291300'),
        release('v1.4.160-daily.202607281300')
      ])
    )

    const builds = await listReleaseBuilds('daily')

    expect(fetchMock.mock.calls[0][0]).toContain('stablyai/orca-daily')
    expect(builds.map((build) => build.version)).toEqual([
      '1.4.160-daily.202607291300',
      '1.4.160-daily.202607281300',
      '1.4.160-daily.202607271300'
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

  // Why: the hourly workflow composes the release title and the picker renders it
  // verbatim, so the two can never drift. A title that only repeats the tag says
  // nothing the version beside it does not, and must not become a picker row
  // reading "v1.4.163-hourly.202607311933".
  it('keeps a composed release title and drops one that repeats the tag', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.163-hourly.202607312054', { name: '1.4.163 • 01 • 07-31 13:54 • e698241' }),
        release('v1.4.163-hourly.202607311933', { name: 'v1.4.163-hourly.202607311933' }),
        release('v1.4.163-hourly.202607311835', { name: '   ' }),
        release('v1.4.163-hourly.202607311735', { name: 42 })
      ])
    )

    const builds = await listReleaseBuilds('hourly')
    expect(builds.map((build) => build.name)).toEqual([
      '1.4.163 • 01 • 07-31 13:54 • e698241',
      null,
      null,
      null
    ])
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

  it('pins a daily tag at the daily repo download path', () => {
    expect(resolveTargetBuild('daily', 'v1.4.160-daily.202607281300')).toEqual({
      tag: 'v1.4.160-daily.202607281300',
      version: '1.4.160-daily.202607281300',
      feedUrl:
        'https://github.com/stablyai/orca-daily/releases/download/v1.4.160-daily.202607281300'
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
