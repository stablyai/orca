import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RelayRegionPreferenceResolver } from './relay-region-preference'

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
    JSON.stringify({ v: 2, directorUrl: DIRECTOR, region: null, expiresAt })
  )
}

function cachePath(path: string): string {
  return join(path, 'orca-relay-region-preference.json')
}

function writeCache(path: string, region: string, expiresAt = 999): void {
  writeFileSync(
    cachePath(path),
    JSON.stringify({ v: 2, directorUrl: DIRECTOR, region, latencyMs: 100, expiresAt })
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
      v: 2,
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
    const cached = JSON.parse(readFileSync(cachePath(path), 'utf8'))
    expect(cached).toEqual({ v: 2, directorUrl: DIRECTOR, region: null, expiresAt: 3_601_000 })
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

    writeCache(path, 'asia-east2', LIVE_EXPIRY)
    await first.resolver.invalidateIfAssignedCellIsFar(CELL)
    expect(existsSync(cachePath(path))).toBe(false)
  })
})
