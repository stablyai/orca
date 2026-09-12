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

/** Every platform's manifest by default, so a case that is not about asset
 *  filtering stays readable and stays green whatever platform is passed. */
const allPlatformAssets = [
  { name: 'latest-mac.yml' },
  { name: 'orca-macos-arm64.dmg' },
  { name: 'latest.yml' },
  { name: 'orca-windows-setup.exe' },
  { name: 'latest-linux.yml' },
  { name: 'orca-linux.AppImage' }
]

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: '2026-07-28T14:00:00Z',
  html_url: `https://github.com/stablyai/orca/releases/tag/${tag}`,
  assets: allPlatformAssets,
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

    const builds = await listReleaseBuilds('hourly', 'darwin')

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

    const builds = await listReleaseBuilds('daily', 'darwin')

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

    await expect(
      listReleaseBuilds('stable', 'darwin').then((b) => b.map((x) => x.version))
    ).resolves.toEqual(['1.4.159', '1.4.158'])

    fetchMock.mockResolvedValue(
      jsonResponse([release('v1.4.160-rc.2'), release('v1.4.159'), release('v1.4.158')])
    )
    await expect(
      listReleaseBuilds('rc', 'darwin').then((b) => b.map((x) => x.version))
    ).resolves.toEqual(['1.4.160-rc.2'])
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

    const builds = await listReleaseBuilds('stable', 'darwin')
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

    const builds = await listReleaseBuilds('hourly', 'darwin')
    expect(builds.map((build) => build.name)).toEqual([
      '1.4.163 • 01 • 07-31 13:54 • e698241',
      null,
      null,
      null
    ])
  })

  // Why: the mac and Windows legs publish into one release independently, and
  // either can fail. Offering a row the running platform has no artifact for
  // sends the user into a download that 404s after they commit to it.
  it('hides builds that published no artifact for this platform', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.163-hourly.202607312054'),
        release('v1.4.163-hourly.202607311933', {
          assets: [{ name: 'latest-mac.yml' }, { name: 'orca-macos-arm64.dmg' }]
        })
      ])
    )

    await expect(
      listReleaseBuilds('hourly', 'win32').then((builds) => builds.map((build) => build.version))
    ).resolves.toEqual(['1.4.163-hourly.202607312054'])
  })

  // The mac-only releases every dev channel published before Windows builds
  // existed must simply not appear on Windows, rather than erroring.
  it('returns an empty list when no build has this platform artifact', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.163-hourly.202607312054', { assets: [{ name: 'latest-mac.yml' }] })
      ])
    )

    await expect(listReleaseBuilds('hourly', 'win32')).resolves.toEqual([])
  })

  it('keeps mac builds visible on macOS regardless of the Windows leg', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.163-hourly.202607312054', { assets: [{ name: 'latest-mac.yml' }] })
      ])
    )

    await expect(
      listReleaseBuilds('hourly', 'darwin').then((builds) => builds.map((build) => build.version))
    ).resolves.toEqual(['1.4.163-hourly.202607312054'])
  })

  // Why: on Windows a signed stable cannot reach a dev channel through the
  // updater, so the picker needs a direct download to hand the user instead.
  it('resolves the platform installer download url', async () => {
    fetchMock.mockResolvedValue(jsonResponse([release('v1.4.163-hourly.202607312054')]))

    const [build] = await listReleaseBuilds('hourly', 'win32')

    expect(build.installerUrl).toBe(
      'https://github.com/stablyai/orca-hourly/releases/download/v1.4.163-hourly.202607312054/orca-windows-setup.exe'
    )
  })

  it('leaves the installer url null when the release published no installer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([release('v1.4.163-hourly.202607312054', { assets: [{ name: 'latest.yml' }] })])
    )

    const [build] = await listReleaseBuilds('hourly', 'win32')

    expect(build.installerUrl).toBeNull()
  })

  it('tolerates a release whose assets are missing or malformed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('v1.4.163-hourly.202607312054', { assets: undefined }),
        release('v1.4.163-hourly.202607311933', { assets: [null, { name: 7 }] })
      ])
    )

    await expect(listReleaseBuilds('hourly', 'win32')).resolves.toEqual([])
  })

  it('surfaces a rate limit as an actionable message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 403 }))
    await expect(listReleaseBuilds('hourly', 'darwin')).rejects.toThrow(/rate limit/i)
  })

  it('reports a missing hourly repo distinctly', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }))
    await expect(listReleaseBuilds('hourly', 'darwin')).rejects.toThrow(/No releases repository/i)
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
