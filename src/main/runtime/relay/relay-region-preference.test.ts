import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../../lib/unread-response-body.test-fixtures'
import { RelayRegionPreferenceResolver } from './relay-region-preference'
import { probeRelayOrigin } from './relay-region-probe'

const DIRECTOR = 'https://relay.example.test'
const US = 'https://us-c1.relay.example.test'
const US_SECONDARY = 'https://us-c2.relay.example.test'
const ASIA = 'https://asia-c1.relay.example.test'
const CELL = 'https://cell-7.relay.example.test'
const BOTH_REGIONS = [
  { region: 'us-central1', probeOrigins: [US] },
  { region: 'asia-east2', probeOrigins: [ASIA] }
]
const tempPaths: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
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

// Each list starts with the discarded warm-up probe, then the three kept samples.
function sampledProbe(samples: Record<string, number[]>) {
  const calls: string[] = []
  const probe = async (origin: string): Promise<number | null> => {
    calls.push(origin)
    return samples[origin]?.shift() ?? null
  }
  return { calls, probe }
}

function writeNoHintCache(path: string, expiresAt: number): void {
  writeFileSync(
    cachePath(path),
    JSON.stringify({ v: 1, directorUrl: DIRECTOR, region: null, expiresAt })
  )
}

function cachePath(path: string): string {
  return join(path, 'orca-relay-region-preference.json')
}

function writeCache(path: string, region: string, expiresAt = 999): void {
  writeFileSync(
    cachePath(path),
    JSON.stringify({ v: 1, directorUrl: DIRECTOR, region, latencyMs: 100, expiresAt })
  )
}

describe('Relay region preference', () => {
  it('measures a warm-up plus three rounds across one- and two-origin catalogs', async () => {
    const path = userDataPath()
    const fetch = catalogFetch([
      { region: 'us-central1', probeOrigins: [US, US_SECONDARY] },
      { region: 'asia-east2', probeOrigins: [ASIA] }
    ])
    const { calls, probe } = sampledProbe({
      [US]: [400, 160, 170, 150],
      [US_SECONDARY]: [390, 155, 165, 145],
      [ASIA]: [90, 35, 40, 30]
    })
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch,
      probe,
      now: () => 1_000
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')
    expect(calls.filter((origin) => origin === US)).toHaveLength(4)
    expect(calls.filter((origin) => origin === US_SECONDARY)).toHaveLength(4)
    expect(calls.filter((origin) => origin === ASIA)).toHaveLength(4)
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      v: 1,
      directorUrl: DIRECTOR,
      region: 'asia-east2',
      latencyMs: 30
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

  it('discards the warm-up probe instead of counting it as the region latency', async () => {
    const path = userDataPath()
    const { calls, probe } = sampledProbe({
      [US]: [5, 40, 42, 44],
      [ASIA]: [7, 300, 302, 304]
    })

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('us-central1')
    expect(calls.filter((origin) => origin === US)).toHaveLength(4)
    expect(calls.filter((origin) => origin === ASIA)).toHaveLength(4)
    // 5 and 7 were the warm-ups; the cached latency is the best kept sample.
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({ latencyMs: 40 })
  })

  it.each([
    {
      name: 'us-central1',
      samples: { [US]: [85, 90, 36, 36], [ASIA]: [230, 220, 218, 218] }
    },
    {
      name: 'asia-east2',
      samples: { [US]: [230, 220, 218, 218], [ASIA]: [85, 90, 36, 36] }
    }
  ])('picks the near region $name despite a cold first sample', async ({ name, samples }) => {
    const path = userDataPath()
    const { probe } = sampledProbe(samples)

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe(name)
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      region: name,
      latencyMs: 36
    })
  })

  it.each([
    { name: 'a flapping near region', near: [50, 10, 20, 400] },
    { name: 'an unreachable near region', near: [] }
  ])('sends no hint when $name leaves a sole survivor', async ({ near }) => {
    const path = userDataPath()
    const { probe } = sampledProbe({ [US]: near, [ASIA]: [230, 220, 218, 218] })

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBeUndefined()
    // The withheld hint is remembered briefly so a reconnect does not re-probe.
    const cached = JSON.parse(readFileSync(cachePath(path), 'utf8'))
    expect(cached).toEqual({ v: 1, directorUrl: DIRECTOR, region: null, expiresAt: 3_601_000 })
  })

  it('reuses the short-lived no-hint cache instead of re-probing on reconnect', async () => {
    const path = userDataPath()
    const { calls, probe } = sampledProbe({ [ASIA]: [230, 220, 218, 218] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBeUndefined()
    // An unreachable region costs its warm-up probe only, not three more rounds.
    expect(calls.filter((origin) => origin === US)).toHaveLength(1)

    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch,
        now: () => 3_600_000
      }).resolve()
    ).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drops an origin that failed its warm-up without losing the region', async () => {
    const path = userDataPath()
    const { calls, probe } = sampledProbe({
      [US]: [300, 36, 38, 40],
      [ASIA]: [400, 218, 220, 222]
    })

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch([
          { region: 'us-central1', probeOrigins: [US, US_SECONDARY] },
          { region: 'asia-east2', probeOrigins: [ASIA] }
        ]),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('us-central1')
    expect(calls.filter((origin) => origin === US_SECONDARY)).toHaveLength(1)
    expect(calls.filter((origin) => origin === US)).toHaveLength(4)
  })

  it('keeps the cached region unless a stable alternative is meaningfully faster', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1')
    const first = sampledProbe({ [US]: [300, 95, 100, 105], [ASIA]: [300, 80, 85, 90] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe: first.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('us-central1')

    writeCache(path, 'us-central1')
    const second = sampledProbe({ [US]: [300, 95, 100, 105], [ASIA]: [300, 55, 60, 65] })
    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe: second.probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('asia-east2')
  })

  it('switches away from a cached far region once both regions measure', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2')
    const { probe } = sampledProbe({ [US]: [85, 90, 36, 36], [ASIA]: [230, 220, 218, 218] })

    await expect(
      new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch: catalogFetch(BOTH_REGIONS),
        probe,
        now: () => 1_000
      }).resolve()
    ).resolves.toBe('us-central1')
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      region: 'us-central1'
    })
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

    const unstable = sampledProbe({ [US]: [15, 10, 20, 400] })
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
    const healthy = sampledProbe({ [ASIA]: [90, 30, 32, 34] })
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
    writeCache(path, 'us-central1', 10 * 24 * 60 * 60_000)
    const healthy = sampledProbe({ [ASIA]: [90, 30, 32, 34] })

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

  it('lets the environment override win and never self-heals its cache', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', 50_000_000)
    vi.stubEnv('ORCA_RELAY_REGION_OVERRIDE', 'asia-east2')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch,
      probe: async () => 900,
      now: () => 1_000
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')
    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      region: 'us-central1'
    })
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

describe('Relay region cache self-heal', () => {
  const LIVE_EXPIRY = 50_000_000

  function resolverFor(path: string, cellMs: number[]) {
    const { calls, probe } = sampledProbe({
      [US]: [300, 36, 38, 40],
      [ASIA]: [400, 218, 220, 222],
      [CELL]: cellMs
    })
    const fetch = catalogFetch(BOTH_REGIONS)
    return {
      calls,
      fetch,
      resolver: new RelayRegionPreferenceResolver({
        directorUrl: DIRECTOR,
        userDataPath: path,
        fetch,
        probe,
        now: () => 1_000
      })
    }
  }

  it('deletes a cache that names the wrong region once the cell measures far', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    const { calls, resolver } = resolverFor(path, [800, 700, 710, 720])

    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(existsSync(cachePath(path))).toBe(false)
    expect(calls.filter((origin) => origin === CELL)).toHaveLength(4)
  })

  it('keeps a wrong cache whose assigned cell is close to the best region', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    const { resolver } = resolverFor(path, [300, 40, 42, 44])

    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      region: 'asia-east2'
    })
  })

  it('keeps a correct cache the director placed away from, without probing the cell', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', LIVE_EXPIRY)
    const { calls, resolver } = resolverFor(path, [800, 700, 710, 720])

    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(JSON.parse(readFileSync(cachePath(path), 'utf8'))).toMatchObject({
      region: 'us-central1'
    })
    expect(calls.filter((origin) => origin === CELL)).toHaveLength(0)
  })

  it.each([
    { name: 'no cache', write: () => {} },
    { name: 'an expired cache', write: (path: string) => writeCache(path, 'asia-east2', 999) },
    { name: 'a no-hint cache', write: (path: string) => writeNoHintCache(path, LIVE_EXPIRY) }
  ])('skips the probes and stays unarmed for $name', async ({ write }) => {
    const path = userDataPath()
    write(path)
    const first = resolverFor(path, [800, 700, 710, 720])

    await first.resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(first.fetch).not.toHaveBeenCalled()
    expect(first.calls).toHaveLength(0)

    // Nothing was checked, so a cache written later must still be checkable.
    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    await first.resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(existsSync(cachePath(path))).toBe(false)
  })

  it('reports a director that cannot list its regions instead of failing silently', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    const events: unknown[] = []
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error('director offline')
      }),
      now: () => 1_000,
      logEvent: (event) => events.push(event)
    })

    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(existsSync(cachePath(path))).toBe(true)
    expect(events).toEqual([
      expect.objectContaining({
        event: 'relay_region_self_heal',
        cachedRegion: 'asia-east2',
        assignedCellUrl: CELL,
        decision: 'kept',
        reason: 'catalog-unavailable'
      })
    ])
  })

  it('probes a given cell only once per process', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    const { calls, resolver } = resolverFor(path, [800, 700, 710, 720])

    await resolver.invalidateIfAssignedCellIsFar(CELL)
    await resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(calls.filter((origin) => origin === CELL)).toHaveLength(4)
  })
})
