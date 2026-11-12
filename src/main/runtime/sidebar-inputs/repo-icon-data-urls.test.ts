import { describe, expect, it, vi } from 'vitest'
import type { RepoIcon } from '../../../shared/repo-icon'
import type { Repo } from '../../../shared/repo-types'
import { RepoIconDataUrls, repoIconId, type RepoIconPngEncoder } from './repo-icon-data-urls'
import type { RepoIconFetch } from './repo-icon-remote-fetch'
import { pngHeader } from './repo-icon-image-fixture'

const AVATAR: RepoIcon = {
  type: 'image',
  src: 'https://github.com/stablyai.png?size=64',
  source: 'github'
}

function repo(id: string, repoIcon: RepoIcon | null): Repo {
  return { id, path: `/r/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, repoIcon }
}

function pngResponse(bytes: Uint8Array = pngHeader(64, 64)): Response {
  return new Response(Buffer.from(bytes), { headers: { 'content-type': 'image/png' } })
}

function setup(
  repos: Repo[],
  options: { encoder?: RepoIconPngEncoder; fetch?: RepoIconFetch } = {}
) {
  let now = 1_000
  const fetch = vi.fn<RepoIconFetch>(options.fetch ?? (async () => pngResponse()))
  const icons = new RepoIconDataUrls({
    repos: () => repos,
    fetch,
    encoder: () => options.encoder,
    now: () => now
  })
  return { icons, fetch, advance: (ms: number) => (now += ms) }
}

describe('RepoIconDataUrls caps', () => {
  it('runs at most four fetches at once', async () => {
    const releases: (() => void)[] = []
    let active = 0
    let peak = 0
    const avatars = Array.from({ length: 10 }, (_, index): RepoIcon => ({
      ...AVATAR,
      src: `https://github.com/owner${index}.png`
    }))
    const { icons } = setup(
      avatars.map((icon, index) => repo(`r${index}`, icon)),
      {
        fetch: () => {
          active += 1
          peak = Math.max(peak, active)
          return new Promise((resolve) =>
            releases.push(() => {
              active -= 1
              resolve(pngResponse())
            })
          )
        }
      }
    )

    const reply = icons.read(avatars.map((icon) => repoIconId(icon)!))
    for (let settled = 0; settled < avatars.length; settled += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(settled))
      releases[settled]()
    }

    expect((await reply).icons.every((icon) => icon.dataUrl !== null)).toBe(true)
    expect(peak).toBe(4)
  })
})

describe('RepoIconDataUrls cache', () => {
  it('retries a failed fetch after five minutes, a success only after an hour', async () => {
    let fail = true
    const { icons, fetch, advance } = setup([repo('a', AVATAR)], {
      fetch: async () => (fail ? new Response(null, { status: 503 }) : pngResponse())
    })
    const id = repoIconId(AVATAR)!

    expect((await icons.read([id])).icons[0].dataUrl).toBeNull()
    fail = false
    advance(4 * 60 * 1000)
    expect((await icons.read([id])).icons[0].dataUrl).toBeNull()
    advance(60 * 1000 + 1)
    expect((await icons.read([id])).icons[0].dataUrl).not.toBeNull()
    advance(59 * 60 * 1000)
    await icons.read([id])
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(60 * 1000 + 1)
    await icons.read([id])
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
