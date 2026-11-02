import { describe, expect, it, vi } from 'vitest'
import type { RepoIcon } from '../../../shared/repo-icon'
import type { Repo } from '../../../shared/repo-types'
import { MAX_REPO_ICON_DATA_URL_BYTES } from '../../../shared/sidebar-list/repo-icon-data-urls-contract'
import { RepoIconDataUrls, repoIconId, type RepoIconPngEncoder } from './repo-icon-data-urls'
import type { RepoIconFetch } from './repo-icon-remote-fetch'
import { pngHeader } from './repo-icon-image-fixture'

const AVATAR: RepoIcon = {
  type: 'image',
  src: 'https://github.com/stablyai.png?size=64',
  source: 'github'
}

function upload(bytes: Uint8Array): RepoIcon {
  return {
    type: 'image',
    src: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    source: 'upload'
  }
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

const ENCODED = new Uint8Array([1, 2, 3])
const ENCODED_URL = 'data:image/png;base64,AQID'

describe('repoIconId', () => {
  it('names image icons by content and leaves glyph icons to the client', () => {
    expect(repoIconId(AVATAR)).toBe(repoIconId({ ...AVATAR, label: 'other' }))
    expect(repoIconId(AVATAR)).not.toBe(repoIconId({ ...AVATAR, src: `${AVATAR.src}x` }))
    expect(repoIconId({ type: 'emoji', emoji: '🐳' })).toBeNull()
    expect(repoIconId(null)).toBeNull()
  })
})

describe('RepoIconDataUrls without an encoder (orcad)', () => {
  it('passes a small fetched image through as a data URL', async () => {
    const bytes = pngHeader(64, 64)
    const { icons } = setup([repo('a', AVATAR)])
    const id = repoIconId(AVATAR)!

    expect(await icons.read([id])).toEqual({
      icons: [{ id, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` }]
    })
  })

  it('falls back for an upload too large to pass through', async () => {
    const icon = upload(pngHeader(64, 64, MAX_REPO_ICON_DATA_URL_BYTES))
    const { icons } = setup([repo('a', icon)])

    expect((await icons.read([repoIconId(icon)!])).icons[0].dataUrl).toBeNull()
  })

  it('answers null for an id no repo shows, in request order', async () => {
    const { icons, fetch } = setup([repo('a', AVATAR)])
    const id = repoIconId(AVATAR)!

    const reply = await icons.read(['missing', id])

    expect(reply.icons.map((icon) => [icon.id, icon.dataUrl === null])).toEqual([
      ['missing', true],
      [id, false]
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('RepoIconDataUrls with an encoder (desktop)', () => {
  it('re-encodes a fetched avatar at 64 px', async () => {
    const encoder = vi.fn<RepoIconPngEncoder>(() => ENCODED)
    const { icons } = setup([repo('a', AVATAR)], { encoder })

    expect((await icons.read([repoIconId(AVATAR)!])).icons[0].dataUrl).toBe(ENCODED_URL)
    expect(encoder).toHaveBeenCalledWith(expect.any(Uint8Array), 64)
  })

  it('re-encodes a large upload rather than dropping it', async () => {
    const icon = upload(pngHeader(1024, 1024, 300 * 1024))
    const { icons } = setup([repo('a', icon)], { encoder: () => ENCODED })

    expect((await icons.read([repoIconId(icon)!])).icons[0].dataUrl).toBe(ENCODED_URL)
  })

  it('steps down to 32 px when the 64 px PNG is over the cap', async () => {
    const huge = new Uint8Array(MAX_REPO_ICON_DATA_URL_BYTES)
    const encoder = vi.fn<RepoIconPngEncoder>((_bytes, edge) => (edge === 64 ? huge : ENCODED))
    const { icons } = setup([repo('a', AVATAR)], { encoder })

    expect((await icons.read([repoIconId(AVATAR)!])).icons[0].dataUrl).toBe(ENCODED_URL)
    expect(encoder.mock.calls.map(([, edge]) => edge)).toEqual([64, 32])
  })

  it('passes a small image the decoder cannot read through, as orcad would', async () => {
    const { icons } = setup([repo('a', AVATAR)], { encoder: () => null })
    expect((await icons.read([repoIconId(AVATAR)!])).icons[0].dataUrl).toMatch(
      /^data:image\/png;base64,/
    )
  })

  it('falls back when neither encoding nor passthrough fits the cap', async () => {
    const icon = upload(pngHeader(64, 64, MAX_REPO_ICON_DATA_URL_BYTES))
    const huge = new Uint8Array(MAX_REPO_ICON_DATA_URL_BYTES)
    const encoder = vi.fn<RepoIconPngEncoder>(() => huge)
    const { icons } = setup([repo('a', icon)], { encoder })

    expect((await icons.read([repoIconId(icon)!])).icons[0].dataUrl).toBeNull()
    expect(encoder).toHaveBeenCalledTimes(2)
  })
})

describe('RepoIconDataUrls caps', () => {
  it('refuses bytes that are not a readable raster image, before decoding', async () => {
    const encoder = vi.fn<RepoIconPngEncoder>(() => ENCODED)
    const { icons } = setup([repo('a', AVATAR)], {
      encoder,
      fetch: async () => pngResponse(new Uint8Array([1, 2, 3, 4]))
    })

    expect((await icons.read([repoIconId(AVATAR)!])).icons[0].dataUrl).toBeNull()
    expect(encoder).not.toHaveBeenCalled()
  })

  it('refuses a fetched image over 512 px before decoding', async () => {
    const encoder = vi.fn<RepoIconPngEncoder>(() => ENCODED)
    const { icons } = setup([repo('a', AVATAR)], {
      encoder,
      fetch: async () => pngResponse(pngHeader(513, 64))
    })

    expect((await icons.read([repoIconId(AVATAR)!])).icons[0].dataUrl).toBeNull()
    expect(encoder).not.toHaveBeenCalled()
  })

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
  it('fetches an avatar shared by two repos once, across concurrent and later reads', async () => {
    const { icons, fetch } = setup([repo('a', AVATAR), repo('b', { ...AVATAR, label: 'b' })])
    const id = repoIconId(AVATAR)!

    await Promise.all([icons.read([id, id]), icons.read([id])])
    await icons.read([id])

    expect(fetch).toHaveBeenCalledTimes(1)
  })

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

  it('evicts the least recently read icons past 1 MiB', async () => {
    const avatars = Array.from({ length: 80 }, (_, index): RepoIcon => ({
      ...AVATAR,
      src: `https://github.com/owner${index}.png`
    }))
    // Each encoded icon is just under the 16 KiB cap, so 80 of them overflow 1 MiB.
    const nearCap = new Uint8Array(12 * 1024 - 64)
    const { icons, fetch } = setup(
      avatars.map((icon, index) => repo(`r${index}`, icon)),
      { encoder: () => nearCap }
    )
    const ids = avatars.map((icon) => repoIconId(icon)!)

    for (let start = 0; start < ids.length; start += 16) {
      await icons.read(ids.slice(start, start + 16))
    }
    expect(fetch).toHaveBeenCalledTimes(80)
    await icons.read([ids[79]])
    expect(fetch).toHaveBeenCalledTimes(80)
    await icons.read([ids[0]])
    expect(fetch).toHaveBeenCalledTimes(81)
  })
})
