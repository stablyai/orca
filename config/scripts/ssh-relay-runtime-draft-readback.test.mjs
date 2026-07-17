import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifySshRelayRuntimeDraftReadback } from './ssh-relay-runtime-draft-readback.mjs'

const TAG = 'v1.4.140-rc.1'
const REPO = 'stablyai/orca'
const TOKEN = 'secret-token'
const bytes = Buffer.from('immutable release bytes')
const expected = {
  name: 'orca-ssh-relay-runtime-v1-linux-x64-glibc-a.tar.br',
  sha256: 'sha256:5396515749878bd28c5dae110040b4fbae1c33f59318b9c23f446319d68e236a',
  size: bytes.length
}

function release(overrides = {}) {
  return {
    id: 42,
    tag_name: TAG,
    draft: true,
    assets: [{ id: 101, name: expected.name, state: 'uploaded', size: expected.size }],
    ...overrides
  }
}

function fetchFixture(assetResponse = new Response(bytes)) {
  return vi
    .fn()
    .mockResolvedValueOnce(Response.json(release()))
    .mockResolvedValueOnce(assetResponse)
}

afterEach(() => vi.restoreAllMocks())

describe('SSH relay runtime draft read-back', () => {
  it('downloads and hashes every exact managed asset from the same draft', async () => {
    const fetchImpl = fetchFixture()

    await expect(
      verifySshRelayRuntimeDraftReadback({
        repo: REPO,
        releaseId: 42,
        tag: TAG,
        token: TOKEN,
        expectedAssets: [expected],
        fetchImpl
      })
    ).resolves.toEqual({ releaseId: 42, tag: TAG, downloadedAssets: [expected] })
  })

  it('follows only the approved asset redirect without forwarding authorization', async () => {
    const location = 'https://release-assets.githubusercontent.com/example/runtime?sig=signed'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(release()))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(new Response(bytes))

    await verifySshRelayRuntimeDraftReadback({
      repo: REPO,
      releaseId: 42,
      tag: TAG,
      token: TOKEN,
      expectedAssets: [expected],
      fetchImpl
    })

    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchImpl.mock.calls[2][0]).toBe(location)
    expect(fetchImpl.mock.calls[2][1].headers).not.toHaveProperty('Authorization')
  })

  it.each([
    ['http://release-assets.githubusercontent.com/runtime', 'HTTPS'],
    ['https://example.com/runtime', 'origin']
  ])('rejects an unsafe asset redirect %s', async (location, message) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(release()))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))

    await expect(
      verifySshRelayRuntimeDraftReadback({
        repo: REPO,
        releaseId: 42,
        tag: TAG,
        token: TOKEN,
        expectedAssets: [expected],
        fetchImpl
      })
    ).rejects.toThrow(new RegExp(message, 'i'))
  })

  it.each(['direct API response', 'redirected CDN response'])(
    'rejects an unexpected successful status from the %s',
    async (responseKind) => {
      const partialResponse = new Response(bytes, {
        status: 206,
        headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }
      })
      const fetchImpl =
        responseKind === 'direct API response'
          ? fetchFixture(partialResponse)
          : vi
              .fn()
              .mockResolvedValueOnce(Response.json(release()))
              .mockResolvedValueOnce(
                new Response(null, {
                  status: 302,
                  headers: {
                    location: 'https://release-assets.githubusercontent.com/example/runtime'
                  }
                })
              )
              .mockResolvedValueOnce(partialResponse)

      await expect(
        verifySshRelayRuntimeDraftReadback({
          repo: REPO,
          releaseId: 42,
          tag: TAG,
          token: TOKEN,
          expectedAssets: [expected],
          fetchImpl
        })
      ).rejects.toThrow(/failed 206/i)
    }
  )

  it('rejects changed, truncated, or oversized returned bytes', async () => {
    for (const body of [
      Buffer.from('changed release bytes'),
      bytes.subarray(1),
      Buffer.concat([bytes, bytes])
    ]) {
      await expect(
        verifySshRelayRuntimeDraftReadback({
          repo: REPO,
          releaseId: 42,
          tag: TAG,
          token: TOKEN,
          expectedAssets: [expected],
          fetchImpl: fetchFixture(new Response(body))
        })
      ).rejects.toThrow(/size|sha-?256/i)
    }
  })

  it('rejects a published, cross-tag, incomplete, or unexpected managed draft', async () => {
    for (const changedRelease of [
      release({ draft: false }),
      release({ tag_name: 'v1.4.140-rc.2' }),
      release({ assets: [] }),
      release({
        assets: [
          ...release().assets,
          { id: 102, name: 'orca-ssh-relay-runtime-extra.zip', state: 'uploaded', size: 1 }
        ]
      })
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(changedRelease))
      await expect(
        verifySshRelayRuntimeDraftReadback({
          repo: REPO,
          releaseId: 42,
          tag: TAG,
          token: TOKEN,
          expectedAssets: [expected],
          fetchImpl
        })
      ).rejects.toThrow(/draft|tag|missing|unexpected/i)
    }
  })

  it('rejects non-uploaded metadata or a mismatched declared size before download', async () => {
    for (const asset of [
      { ...release().assets[0], state: 'new' },
      { ...release().assets[0], size: expected.size + 1 }
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(release({ assets: [asset] })))
      await expect(
        verifySshRelayRuntimeDraftReadback({
          repo: REPO,
          releaseId: 42,
          tag: TAG,
          token: TOKEN,
          expectedAssets: [expected],
          fetchImpl
        })
      ).rejects.toThrow(/uploaded|size/i)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('honors cancellation before any GitHub request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancel read-back'))
    const fetchImpl = vi.fn()

    await expect(
      verifySshRelayRuntimeDraftReadback({
        repo: REPO,
        releaseId: 42,
        tag: TAG,
        token: TOKEN,
        expectedAssets: [expected],
        fetchImpl,
        signal: controller.signal
      })
    ).rejects.toThrow(/cancel read-back/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
