import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../../lib/unread-response-body.test-fixtures'
import { probeRelayOrigin, RelayRegionPreferenceResolver } from './relay-region-preference'

const DIRECTOR = 'https://relay.example.test'
const US = 'https://us-c1.relay.example.test'
const US_SECONDARY = 'https://us-c2.relay.example.test'
const ASIA = 'https://asia-c1.relay.example.test'
const tempPaths: string[] = []

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function userDataPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-relay-region-'))
  tempPaths.push(path)
  return path
}

function catalogFetch(regions: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () => Response.json({ v: 1, regions }))
}

function sampledProbe(samples: Record<string, number[]>) {
  const calls: string[] = []
  const probe = async (origin: string): Promise<number | null> => {
    calls.push(origin)
    return samples[origin]?.shift() ?? null
  }
  return { calls, probe }
}

function cachePath(path: string): string {
  return join(path, 'orca-relay-region-preference.json')
}

describe('Relay region preference', () => {
  it('measures three rounds across one- and two-origin catalogs and caches Asia', async () => {
    const path = userDataPath()
    const fetch = catalogFetch([
      { region: 'us-central1', probeOrigins: [US, US_SECONDARY] },
      { region: 'asia-east2', probeOrigins: [ASIA] }
    ])
    const { calls, probe } = sampledProbe({
      [US]: [160, 170, 150],
      [US_SECONDARY]: [155, 165, 145],
      [ASIA]: [35, 40, 30]
    })
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch,
      probe,
      now: () => 1_000
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')
    expect(calls.filter((origin) => origin === US)).toHaveLength(3)
    expect(calls.filter((origin) => origin === US_SECONDARY)).toHaveLength(3)
    expect(calls.filter((origin) => origin === ASIA)).toHaveLength(3)
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      v: 1,
      directorUrl: DIRECTOR,
      region: 'asia-east2',
      latencyMs: 35
    })

    const offlineFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('offline')
    })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: offlineFetch,
        now: () => 2_000
      }).resolve()
    ).resolves.toBe('asia-east2')
    expect(offlineFetch).not.toHaveBeenCalled()
  })

  it('keeps the cached region unless a stable alternative is meaningfully faster', async () => {
    const path = userDataPath()
    writeFileSync(
      cachePath(path),
      JSON.stringify({
        v: 1,
        directorUrl: DIRECTOR,
        region: 'us-central1',
        latencyMs: 100,
        expiresAt: 999
      })
    )
    const regions = [
      { region: 'us-central1', probeOrigins: [US] },
      { region: 'asia-east2', probeOrigins: [ASIA] }
    ]
    const first = sampledProbe({ [US]: [95, 100, 105], [ASIA]: [80, 85, 90] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(regions),
        probe: first.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('us-central1')

    writeFileSync(
      cachePath(path),
      JSON.stringify({
        v: 1,
        directorUrl: DIRECTOR,
        region: 'us-central1',
        latencyMs: 100,
        expiresAt: 999
      })
    )
    const second = sampledProbe({ [US]: [95, 100, 105], [ASIA]: [55, 60, 65] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(regions),
        probe: second.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('asia-east2')
  })

  it('falls back without a hint for corrupt cache, old catalogs, and unstable probes', async () => {
    const path = userDataPath()
    writeFileSync(cachePath(path), '{not-json')
    const invalidCatalogs = [
      [{ region: 'unknown', probeOrigins: [US] }],
      [
        { region: 'us-central1', probeOrigins: [US] },
        { region: 'asia-east2', probeOrigins: [US] }
      ],
      [{ region: 'us-central1', probeOrigins: ['http://us.relay.example.test'] }],
      [{ region: 'us-central1', probeOrigins: ['https://external.example.test'] }]
    ]
    for (const regions of invalidCatalogs) {
      await expect(
        new RelayRegionPreferenceResolver({
          directorUrl: DIRECTOR,
          userDataPath: path,
          fetch: catalogFetch(regions),
          probe: async () => 10,
          now: () => 1_000
        }).resolve()
      ).resolves.toBeUndefined()
    }

    const unstable = sampledProbe({ [US]: [10, 20, 200] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch([{ region: 'us-central1', probeOrigins: [US] }]),
        probe: unstable.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBeUndefined()
  })

  it('recovers from corrupt cache and cancels an old directors error response', async () => {
    const path = userDataPath()
    writeFileSync(cachePath(path), '{not-json')
    const healthy = sampledProbe({ [ASIA]: [30, 32, 34] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch([{ region: 'asia-east2', probeOrigins: [ASIA] }]),
        probe: healthy.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('asia-east2')

    rmSync(cachePath(path), { force: true })
    let cancelled = 0
    const oldDirector = vi.fn<typeof globalThis.fetch>(async () =>
      cancelTrackingResponse(404, () => {
        cancelled += 1
      })
    )
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: oldDirector,
        now: () => 1_000
      }).resolve()
    ).resolves.toBeUndefined()
    expect(cancelled).toBe(1)
  })

  it('rejects a cache expiry beyond the 24-hour bound', async () => {
    const path = userDataPath()
    writeFileSync(
      cachePath(path),
      JSON.stringify({
        v: 1,
        directorUrl: DIRECTOR,
        region: 'us-central1',
        latencyMs: 100,
        expiresAt: 10 * 24 * 60 * 60_000
      })
    )
    const healthy = sampledProbe({ [ASIA]: [30, 32, 34] })

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch([{ region: 'asia-east2', probeOrigins: [ASIA] }]),
        probe: healthy.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('asia-east2')
  })

  it('uses a valid diagnostic override without network or cache mutation', async () => {
    const path = userDataPath()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      diagnosticOverride: 'asia-east2',
      fetch
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds an offline catalog request and returns no preference', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: userDataPath(),
        fetch,
        requestTimeoutMs: 5
      }).resolve()
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('probes only the canonical health path and cancels its body', async () => {
    let cancelled = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      cancelTrackingResponse(200, () => {
        cancelled += 1
      })
    )
    const times = [10, 42]

    await expect(probeRelayOrigin(ASIA, fetch, () => times.shift()!)).resolves.toBe(32)
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ASIA}/health`)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
    expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined()
    expect(cancelled).toBe(1)
  })
})
