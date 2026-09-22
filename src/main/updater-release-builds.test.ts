import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))

const tokenMock = vi.fn<() => Promise<string | null>>()
let tokenScope = 'native:github.com'
const rejectTokenMock = vi.fn()
vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: async () => {
    const token = await tokenMock()
    return token === null ? null : { token, rateLimitScope: tokenScope }
  },
  rejectReleaseApiToken: () => rejectTokenMock()
}))

const blockedUntilMock = vi.fn<(bucket: string, now: number, scope: string) => number | null>()
const recordRateLimitMock = vi.fn()
vi.mock('./git/gh-rate-limit-breaker', () => ({
  getGhRateLimitBlockedUntilMs: (...args: Parameters<typeof blockedUntilMock>) =>
    blockedUntilMock(...args),
  recordGhPrimaryRateLimit: (...args: unknown[]) => recordRateLimitMock(...args)
}))

const { describeRateLimitReset, listReleaseBuilds, rateLimitResetAtMs, resolveTargetBuild } =
  await import('./updater-release-builds')

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: () => Promise.resolve(body)
  }
}

function requestHeaders(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call][1].headers
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
    tokenScope = 'native:github.com'
    fetchMock.mockReset()
    rejectTokenMock.mockReset()
    recordRateLimitMock.mockReset()
    tokenMock.mockReset()
    tokenMock.mockResolvedValue(null)
    blockedUntilMock.mockReset()
    blockedUntilMock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  // Why: unauthenticated requests draw from a 60/hour bucket shared by every
  // caller behind the same IP; the user's own token has a 5000/hour bucket.
  it('sends the local gh token as a bearer header when one is available', async () => {
    tokenMock.mockResolvedValue('gho_abc')
    fetchMock.mockResolvedValue(jsonResponse([release('v1.4.159')]))

    await listReleaseBuilds('stable', 'darwin')

    expect(requestHeaders()).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer gho_abc'
    })
  })

  it('sends no authorization header when gh has no token', async () => {
    fetchMock.mockResolvedValue(jsonResponse([release('v1.4.159')]))

    await listReleaseBuilds('stable', 'darwin')

    expect(requestHeaders()).toEqual({ Accept: 'application/vnd.github+json' })
  })

  // Why: a revoked keyring token must not take the picker down when the
  // unauthenticated request still lists the public repo.
  it('retries unauthenticated once when GitHub rejects the token', async () => {
    tokenMock.mockResolvedValue('gho_stale')
    fetchMock
      .mockResolvedValueOnce(jsonResponse(null, { ok: false, status: 401 }))
      .mockResolvedValueOnce(jsonResponse([release('v1.4.159')]))

    await expect(
      listReleaseBuilds('stable', 'darwin').then((builds) => builds.map((build) => build.version))
    ).resolves.toEqual(['1.4.159'])

    expect(rejectTokenMock).toHaveBeenCalledTimes(1)
    expect(requestHeaders(1)).toEqual({ Accept: 'application/vnd.github+json' })
  })

  it('does not retry a 401 that was already unauthenticated', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 401 }))

    await expect(listReleaseBuilds('stable', 'darwin')).rejects.toThrow(/HTTP 401/)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rejectTokenMock).not.toHaveBeenCalled()
  })

  // Why: the token's 5000/hour bucket and the per-IP bucket are independent, so
  // a spent token — an agent running gh in a loop — must not take the picker down
  // while the unauthenticated request would still succeed.
  it('falls back to the per-IP bucket when the token is rate limited and tells the gh breaker', async () => {
    tokenMock.mockResolvedValue('gho_abc')
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(null, {
          ok: false,
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000600' }
        })
      )
      .mockResolvedValueOnce(jsonResponse([release('v1.4.159')]))

    await expect(
      listReleaseBuilds('stable', 'darwin').then((builds) => builds.map((build) => build.version))
    ).resolves.toEqual(['1.4.159'])

    expect(recordRateLimitMock).toHaveBeenCalledWith('core', 1_800_000_600_000, 'native:github.com')
    expect(rejectTokenMock).not.toHaveBeenCalled()
    expect(requestHeaders(1)).toEqual({ Accept: 'application/vnd.github+json' })
  })

  // Why: GitHub attaches `x-ratelimit-remaining: 0` to some secondary limits too, and
  // those carry Retry-After, which bars any retry before it elapses — the per-IP one
  // included. Tripping the primary breaker would also block every unrelated core gh
  // command until the hourly reset over a short abuse-throttle.
  it('reports a secondary limit carrying retry-after without retrying or tripping the breaker', async () => {
    const nowMs = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(nowMs)
    tokenMock.mockResolvedValue('gho_abc')
    fetchMock.mockResolvedValue(
      jsonResponse(null, {
        ok: false,
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(nowMs / 1000 + 60 * 60),
          'retry-after': '60'
        }
      })
    )

    await expect(listReleaseBuilds('stable', 'darwin')).rejects.toThrow(
      'GitHub rate limit reached. Try again in about a minute.'
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(recordRateLimitMock).not.toHaveBeenCalled()
  })

  it.each(['native:github.com', 'wsl:ubuntu:github.com'])(
    'records a primary limit in the token scope %s',
    async (scope) => {
      tokenScope = scope
      tokenMock.mockResolvedValue('gho_abc')
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(null, {
            ok: false,
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000600' }
          })
        )
        .mockResolvedValueOnce(jsonResponse([release('v1.4.159')]))

      await listReleaseBuilds('stable', 'win32')

      expect(recordRateLimitMock).toHaveBeenCalledExactlyOnceWith('core', 1_800_000_600_000, scope)
    }
  )

  it.each([
    ['native:github.com', 'wsl:ubuntu:github.com'],
    ['wsl:ubuntu:github.com', 'native:github.com'],
    ['wsl:ubuntu:github.com', 'wsl:debian:github.com']
  ])('keeps %s authenticated when only %s is blocked', async (scope, blockedScope) => {
    tokenScope = scope
    tokenMock.mockResolvedValue('gho_abc')
    blockedUntilMock.mockImplementation((_bucket, now, queriedScope) =>
      queriedScope === blockedScope ? now + 60_000 : null
    )
    fetchMock.mockResolvedValue(jsonResponse([release('v1.4.159')]))

    await listReleaseBuilds('stable', 'win32')

    expect(blockedUntilMock).toHaveBeenCalledWith('core', expect.any(Number), scope)
    expect(requestHeaders().Authorization).toBe('Bearer gho_abc')
  })

  it.each(['native:github.com', 'wsl:ubuntu:github.com'])(
    'skips the token while its scope %s is blocked',
    async (scope) => {
      tokenScope = scope
      blockedUntilMock.mockReturnValue(Date.now() + 60_000)
      tokenMock.mockResolvedValue('gho_abc')
      fetchMock.mockResolvedValue(
        jsonResponse(null, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      )

      const failure = listReleaseBuilds('stable', 'darwin')
      await expect(failure).rejects.toThrow(/rate limit reached/)
      // Why: the user is signed in; the breaker, not a missing login, kept the token home.
      await expect(failure).rejects.not.toThrow(/gh auth login/)

      expect(tokenMock).toHaveBeenCalledTimes(1)
      expect(blockedUntilMock).toHaveBeenCalledWith('core', expect.any(Number), scope)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(requestHeaders()).toEqual({ Accept: 'application/vnd.github+json' })
    }
  )

  it('surfaces a rate limit with its reset time and a sign-in hint when unauthenticated', async () => {
    const nowMs = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(nowMs)
    fetchMock.mockResolvedValue(
      jsonResponse(null, {
        ok: false,
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(nowMs / 1000 + 28 * 60)
        }
      })
    )

    await expect(listReleaseBuilds('hourly', 'darwin')).rejects.toThrow(
      "GitHub rate limit reached. Try again in about 28 minutes, or run `gh auth login` so Orca can use your account's higher limit."
    )
  })

  it('omits the sign-in hint when the rate-limited request was authenticated', async () => {
    tokenMock.mockResolvedValue('gho_abc')
    fetchMock.mockResolvedValue(
      jsonResponse(null, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    )

    const failure = listReleaseBuilds('hourly', 'darwin')
    await expect(failure).rejects.toThrow(/rate limit reached/)
    await expect(failure).rejects.not.toThrow(/gh auth login/)
  })

  it('treats 429 as a rate limit', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(null, { ok: false, status: 429, headers: { 'retry-after': '90' } })
    )

    await expect(listReleaseBuilds('hourly', 'darwin')).rejects.toThrow(/in about 2 minutes/)
  })

  // Why: a 403 without rate-limit headers is a permission or access problem, and
  // telling the user to wait would send them waiting for a reset that never comes.
  it('reports a 403 without rate-limit headers as a plain HTTP error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 403 }))

    const failure = listReleaseBuilds('hourly', 'darwin')
    await expect(failure).rejects.toThrow(/HTTP 403/)
    await expect(failure).rejects.not.toThrow(/rate limit/)
  })

  it('reports a missing hourly repo distinctly', async () => {
    fetchMock.mockResolvedValue(jsonResponse(null, { ok: false, status: 404 }))
    await expect(listReleaseBuilds('hourly', 'darwin')).rejects.toThrow(/No releases repository/i)
  })
})

describe('rateLimitResetAtMs', () => {
  const nowMs = 1_800_000_000_000

  it('is null when GitHub sent no reset', () => {
    expect(rateLimitResetAtMs(new Headers(), nowMs)).toBeNull()
  })

  // Why: a secondary limit sends both, and only Retry-After is the wait GitHub asked
  // for — quoting the hour-out primary window would tell the user to wait far too long.
  it('prefers retry-after over the primary reset epoch', () => {
    const headers = new Headers({
      'x-ratelimit-reset': String(nowMs / 1000 + 10 * 60),
      'retry-after': '30'
    })
    expect(rateLimitResetAtMs(headers, nowMs)).toBe(nowMs + 30_000)
  })

  it('falls back to the primary reset epoch when there is no retry-after', () => {
    const headers = new Headers({ 'x-ratelimit-reset': String(nowMs / 1000 + 10 * 60) })
    expect(rateLimitResetAtMs(headers, nowMs)).toBe(nowMs + 10 * 60_000)
  })

  it('reads retry-after as seconds', () => {
    expect(rateLimitResetAtMs(new Headers({ 'retry-after': '90' }), nowMs)).toBe(nowMs + 90_000)
  })

  // Why: secondary limits may send Retry-After as an HTTP date (RFC 9110).
  it('reads retry-after as an HTTP date', () => {
    const headers = new Headers({ 'retry-after': new Date(nowMs + 5 * 60_000).toUTCString() })
    expect(rateLimitResetAtMs(headers, nowMs)).toBe(nowMs + 5 * 60_000)
  })
})

describe('describeRateLimitReset', () => {
  const nowMs = 1_800_000_000_000

  it('falls back to a vague wait when the reset is unknown', () => {
    expect(describeRateLimitReset(null, nowMs)).toBe('in a few minutes')
  })

  it('rounds a sub-minute reset up to a minute', () => {
    expect(describeRateLimitReset(nowMs + 20_000, nowMs)).toBe('in about a minute')
  })

  it('rounds a partial minute up', () => {
    expect(describeRateLimitReset(nowMs + 9 * 60_000 + 1, nowMs)).toBe('in about 10 minutes')
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
