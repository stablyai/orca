import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createGithubReleaseUpdateSource } from './github-release-update-source'

// Recorded once from the live endpoints on 2026-09-28, unedited.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}
const tagRefs = fixture('github-mobile-android-tag-refs.json')
const release050 = fixture('github-release-mobile-android-v0.0.50.json')

const REFS_URL =
  'https://api.github.com/repos/stablyai/orca/git/matching-refs/tags/mobile-android-v'
const releaseUrl = (version: string) =>
  `https://api.github.com/repos/stablyai/orca/releases/tags/mobile-android-v${version}`

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const requested: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    const route = routes[url]
    if (!route) {
      throw new Error(`unexpected request ${url}`)
    }
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status })
  }
  return { fetchImpl, requested }
}

const signal = new AbortController().signal

describe('GitHub release source (Android sideload)', () => {
  it('offers the newest tag above the installed version once its release is proven', async () => {
    const { fetchImpl, requested } = fakeFetch({
      [REFS_URL]: { status: 200, body: tagRefs },
      [releaseUrl('0.0.50')]: { status: 200, body: release050 }
    })
    await expect(
      createGithubReleaseUpdateSource(fetchImpl).check('0.0.47', signal)
    ).resolves.toEqual({
      kind: 'available',
      version: '0.0.50',
      url: 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.50'
    })
    expect(requested).toEqual([REFS_URL, releaseUrl('0.0.50')])
  })

  it('falls back past a tag whose build never published a release', async () => {
    const release048 = { ...Object(release050), html_url: 'https://example.test/048' }
    const { fetchImpl } = fakeFetch({
      [REFS_URL]: { status: 200, body: tagRefs },
      [releaseUrl('0.0.50')]: { status: 404 },
      [releaseUrl('0.0.48')]: { status: 200, body: release048 }
    })
    await expect(
      createGithubReleaseUpdateSource(fetchImpl).check('0.0.47', signal)
    ).resolves.toEqual({
      kind: 'available',
      version: '0.0.48',
      url: 'https://example.test/048'
    })
  })

  it('rejects on a release probe 5xx instead of moving to an older candidate', async () => {
    const { fetchImpl, requested } = fakeFetch({
      [REFS_URL]: { status: 200, body: tagRefs },
      [releaseUrl('0.0.50')]: { status: 502 }
    })
    await expect(
      createGithubReleaseUpdateSource(fetchImpl).check('0.0.47', signal)
    ).rejects.toThrow('release HTTP 502')
    expect(requested).toEqual([REFS_URL, releaseUrl('0.0.50')])
  })
})
