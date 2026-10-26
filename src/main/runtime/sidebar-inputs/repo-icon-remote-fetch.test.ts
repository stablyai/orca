import { describe, expect, it, vi } from 'vitest'
import {
  fetchRemoteRepoIcon,
  REPO_ICON_FETCH_MAX_BYTES,
  type RepoIconFetch
} from './repo-icon-remote-fetch'
import { pngHeader } from './repo-icon-image-fixture'

const AVATAR = 'https://github.com/stablyai.png?size=64'

function image(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers }
  })
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

describe('fetchRemoteRepoIcon', () => {
  it('follows up to three https redirects without cookies', async () => {
    const fetch = vi
      .fn<RepoIconFetch>()
      .mockResolvedValueOnce(redirect('https://avatars.example/a'))
      .mockResolvedValueOnce(redirect('/b'))
      .mockResolvedValueOnce(redirect('https://avatars.example/c'))
      .mockResolvedValueOnce(image(pngHeader(64, 64)))

    const fetched = await fetchRemoteRepoIcon(AVATAR, fetch)

    expect(fetched?.mimeType).toBe('image/png')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      AVATAR,
      'https://avatars.example/a',
      'https://avatars.example/b',
      'https://avatars.example/c'
    ])
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', credentials: 'omit' })
  })

  it('gives up on a redirect loop after three hops', async () => {
    const fetch = vi.fn<RepoIconFetch>(async () => redirect(AVATAR))

    expect(await fetchRemoteRepoIcon(AVATAR, fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('refuses a redirect off https', async () => {
    const fetch = vi.fn<RepoIconFetch>(async () => redirect('http://avatars.example/a'))

    expect(await fetchRemoteRepoIcon(AVATAR, fetch)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a body declared over the cap without reading it', async () => {
    const response = image(pngHeader(64, 64), {
      'content-length': String(REPO_ICON_FETCH_MAX_BYTES + 1)
    })
    const cancel = vi.spyOn(response.body!, 'cancel')

    expect(await fetchRemoteRepoIcon(AVATAR, async () => response)).toBeNull()
    expect(cancel).toHaveBeenCalled()
  })

  it('stops reading an undeclared body once it passes the cap', async () => {
    const chunk = new Uint8Array(16 * 1024)
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1
        controller.enqueue(chunk)
      }
    })
    const response = new Response(body, { headers: { 'content-type': 'image/png' } })

    expect(await fetchRemoteRepoIcon(AVATAR, async () => response)).toBeNull()
    expect(pulls).toBeLessThan(10)
  })

  it('refuses a reply that is not a raster image', async () => {
    const svg = new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
    expect(await fetchRemoteRepoIcon(AVATAR, async () => svg)).toBeNull()
    const missing = new Response('nope', { status: 404, headers: { 'content-type': 'image/png' } })
    expect(await fetchRemoteRepoIcon(AVATAR, async () => missing)).toBeNull()
  })

  it('refuses non-https and credentialed sources', async () => {
    const fetch = vi.fn<RepoIconFetch>()
    expect(await fetchRemoteRepoIcon('http://github.com/a.png', fetch)).toBeNull()
    expect(await fetchRemoteRepoIcon('https://user:pw@github.com/a.png', fetch)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('times out a server that never answers', async () => {
    const fetch: RepoIconFetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      )

    expect(await fetchRemoteRepoIcon(AVATAR, fetch, 20)).toBeNull()
  })

  it('times out a body that stalls after the headers', async () => {
    const fetch: RepoIconFetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
        }
      })
      return new Response(body, { headers: { 'content-type': 'image/png' } })
    }

    expect(await fetchRemoteRepoIcon(AVATAR, fetch, 20)).toBeNull()
  })
})
