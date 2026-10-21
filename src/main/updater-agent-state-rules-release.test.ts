// Regression: agent state rules releases live in the app's own release feed, and must never change
// what the updater resolves on any path: the stable Latest feed, the RC prerelease feed, or the
// build picker.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getVersionChannel } from '../shared/release-channel'
import { installNetRequestFetchAdapter } from './updater-net-request.fixture'

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock, request: netRequestMock } }))
vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: async () => null,
  rejectReleaseApiToken: () => {}
}))
vi.mock('./git/gh-rate-limit-breaker', () => ({
  getGhRateLimitBlockedUntilMs: () => null,
  recordGhPrimaryRateLimit: () => {}
}))

const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
const { listReleaseBuilds, resolveTargetBuild } = await import('./updater-release-builds')

const RULES_TAGS = ['agent-state-rules-engine-1-next', 'agent-state-rules-engine-1-stable']
const APP_TAGS = ['v1.4.3-rc.1', 'v1.4.2', 'v1.4.2-rc.4', 'v1.4.1']

function atomFeed(tags: readonly string[]): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
}

function serveFeed(tags: readonly string[]): void {
  netFetchMock.mockImplementation((url: string) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(atomFeed(tags)) })
    }
    const manifest = url.match(/\/releases\/download\/v([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
    if (manifest) {
      const version = manifest[1]
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            `version: ${version}\npath: Orca-${version}.zip\nfiles:\n  - url: Orca-${version}.zip\n`
          )
      })
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
  })
}

function apiRelease(tag: string, assets: readonly string[]) {
  return {
    tag_name: tag,
    draft: false,
    published_at: '2026-10-01T00:00:00Z',
    html_url: `https://github.com/stablyai/orca/releases/tag/${tag}`,
    assets: assets.map((name) => ({ name }))
  }
}

const APP_ASSETS = [
  'latest-mac.yml',
  'orca-macos-arm64.dmg',
  'latest.yml',
  'orca-windows-setup.exe'
]

beforeEach(() => {
  netFetchMock.mockReset()
  netRequestMock.mockReset()
  installNetRequestFetchAdapter(netRequestMock, netFetchMock)
})

describe('agent state rules releases and the app updater', () => {
  it('leave the RC prerelease feed resolving to the same app tag', async () => {
    serveFeed(APP_TAGS)
    const withoutRules = await fetchNewerReleaseTag('1.4.2-rc.4')
    serveFeed([...RULES_TAGS, ...APP_TAGS])
    expect(await fetchNewerReleaseTag('1.4.2-rc.4')).toBe(withoutRules)
    expect(withoutRules).toBe('v1.4.3-rc.1')
  })

  it('leave the stable check resolving to the same app tag', async () => {
    serveFeed([...RULES_TAGS, ...APP_TAGS])
    expect(await fetchNewerReleaseTag('1.4.1', { includePrerelease: false })).toBe('v1.4.2')
  })

  it.each(['stable', 'rc'] as const)('never appear in the %s build picker', async (channel) => {
    netFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        Promise.resolve([
          ...RULES_TAGS.map((tag) => apiRelease(tag, ['agent-state-rules.json'])),
          ...APP_TAGS.map((tag) => apiRelease(tag, APP_ASSETS))
        ])
    })
    const builds = await listReleaseBuilds(channel, 'darwin')
    expect(builds.map((build) => build.tag).filter((tag) => RULES_TAGS.includes(tag))).toEqual([])
    expect(builds.length).toBeGreaterThan(0)
  })

  it('cannot be pinned as a build or read as any app channel', () => {
    for (const tag of RULES_TAGS) {
      expect(getVersionChannel(tag)).toBeNull()
      expect(() => resolveTargetBuild('stable', tag)).toThrow('not a valid release tag')
    }
  })
})
