import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayRegionPreferenceResolver } from './relay-region-preference'
import {
  logRelayRegionEvent,
  RELAY_REGION_PROBE_EVENT,
  RELAY_REGION_SELF_HEAL_EVENT,
  type RelayRegionLogEvent,
  type RelayRegionProbeLogEvent,
  type RelayRegionSelfHealLogEvent
} from './relay-region-probe-log'

const DIRECTOR = 'https://relay.example.test'
const US = 'https://us-c1.relay.example.test'
const ASIA = 'https://asia-c1.relay.example.test'
const CELL = 'https://cell-7.relay.example.test'
const BOTH_REGIONS = [
  { region: 'us-central1', probeOrigins: [US] },
  { region: 'asia-east2', probeOrigins: [ASIA] }
]
const tempPaths: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function userDataPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-relay-region-log-'))
  tempPaths.push(path)
  return path
}

function catalogFetch(regions: unknown) {
  return vi.fn<typeof globalThis.fetch>(async () => Response.json({ v: 1, regions }))
}

// Each list starts with the discarded warm-up probe, then the three kept samples.
function sampledProbe(samples: Record<string, number[]>) {
  return async (origin: string): Promise<number | null> => samples[origin]?.shift() ?? null
}

function writeCache(path: string, region: string | null, expiresAt: number): void {
  writeFileSync(
    join(path, 'orca-relay-region-preference.json'),
    JSON.stringify({ v: 1, directorUrl: DIRECTOR, region, expiresAt })
  )
}

function resolverWithLog(options: {
  path: string
  fetch: typeof globalThis.fetch
  probe?: (origin: string) => Promise<number | null>
  now?: () => number
}) {
  const events: RelayRegionLogEvent[] = []
  const resolver = new RelayRegionPreferenceResolver({
    directorUrl: DIRECTOR,
    userDataPath: options.path,
    fetch: options.fetch,
    probe: options.probe,
    now: options.now ?? (() => 1_000),
    logEvent: (event) => events.push(event)
  })
  return { resolver, events }
}

function probeEvents(events: RelayRegionLogEvent[]): RelayRegionProbeLogEvent[] {
  return events.filter(
    (event): event is RelayRegionProbeLogEvent => event.event === RELAY_REGION_PROBE_EVENT
  )
}

describe('Relay region probe log', () => {
  it('records every probed origin, the discarded warm-up, and the kept samples', async () => {
    const path = userDataPath()
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({ [US]: [400, 160, 170, 150], [ASIA]: [90, 35, 40, 30] })
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')

    const [event] = probeEvents(events)
    expect(event).toMatchObject({
      event: 'relay_region_probe',
      directorHost: 'relay.example.test',
      chosenRegion: 'asia-east2',
      reason: 'measured',
      cached: false,
      ttlMs: 24 * 60 * 60_000
    })
    expect(JSON.stringify(event)).not.toMatch(/token|jwt|secret|authorization|bearer|eyJ/i)
    expect(event.regions).toEqual([
      {
        region: 'us-central1',
        origins: [US],
        warmupMs: [400],
        keptMs: [150, 160, 170],
        minMs: 150,
        spreadMs: 20,
        verdict: 'measured'
      },
      {
        region: 'asia-east2',
        origins: [ASIA],
        warmupMs: [90],
        keptMs: [30, 35, 40],
        minMs: 30,
        spreadMs: 10,
        verdict: 'measured'
      }
    ])
  })

  it('reports a flapping region as rejected-spread and withholds the hint', async () => {
    const path = userDataPath()
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({ [US]: [400, 160, 170, 150], [ASIA]: [90, 30, 40, 900] })
    })

    await expect(resolver.resolve()).resolves.toBeUndefined()

    const [event] = probeEvents(events)
    expect(event.regions.map((region) => region.verdict)).toEqual(['measured', 'rejected-spread'])
    expect(event).toMatchObject({
      chosenRegion: 'no-hint',
      reason: 'sole-survivor-forbidden',
      ttlMs: 60 * 60_000
    })
  })

  it('separates an unreachable region from a rejected one', async () => {
    const path = userDataPath()
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({})
    })

    await expect(resolver.resolve()).resolves.toBeUndefined()

    const [event] = probeEvents(events)
    expect(event.reason).toBe('all-unreachable')
    expect(event.regions).toEqual([
      {
        region: 'us-central1',
        origins: [US],
        warmupMs: [null],
        keptMs: [],
        minMs: null,
        spreadMs: null,
        verdict: 'unreachable'
      },
      {
        region: 'asia-east2',
        origins: [ASIA],
        warmupMs: [null],
        keptMs: [],
        minMs: null,
        spreadMs: null,
        verdict: 'unreachable'
      }
    ])
  })

  it('names a held incumbent apart from a fresh measurement', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', 500)
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({ [US]: [400, 100, 100, 100], [ASIA]: [90, 90, 90, 90] })
    })

    await expect(resolver.resolve()).resolves.toBe('us-central1')

    expect(probeEvents(events)[0]).toMatchObject({
      chosenRegion: 'us-central1',
      reason: 'held-previous'
    })
  })

  it('logs a cache hit with the remaining TTL and no probe rounds', async () => {
    const path = userDataPath()
    writeCache(path, 'asia-east2', 5_000)
    const fetch = catalogFetch(BOTH_REGIONS)
    const { resolver, events } = resolverWithLog({ path, fetch })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')

    expect(fetch).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        event: 'relay_region_probe',
        directorHost: 'relay.example.test',
        regions: [],
        chosenRegion: 'asia-east2',
        reason: 'cached',
        cached: true,
        ttlMs: 4_000
      }
    ])
  })

  it('logs a cached no-hint as no-hint rather than an absent region', async () => {
    const path = userDataPath()
    writeCache(path, null, 5_000)
    const { resolver, events } = resolverWithLog({ path, fetch: catalogFetch(BOTH_REGIONS) })

    await expect(resolver.resolve()).resolves.toBeUndefined()

    expect(probeEvents(events)[0]).toMatchObject({ chosenRegion: 'no-hint', reason: 'cached' })
  })

  it('logs a diagnostic override without probing', async () => {
    const path = userDataPath()
    const events: RelayRegionLogEvent[] = []
    const resolver = new RelayRegionPreferenceResolver({
      directorUrl: DIRECTOR,
      userDataPath: path,
      fetch: catalogFetch(BOTH_REGIONS),
      diagnosticOverride: 'asia-east2',
      logEvent: (event) => events.push(event)
    })

    await expect(resolver.resolve()).resolves.toBe('asia-east2')

    expect(probeEvents(events)[0]).toMatchObject({
      chosenRegion: 'asia-east2',
      reason: 'override',
      cached: false
    })
  })

  it('logs a director that cannot list its regions instead of going silent', async () => {
    const path = userDataPath()
    const { resolver, events } = resolverWithLog({
      path,
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response('nope', { status: 503 }))
    })

    await expect(resolver.resolve()).resolves.toBeUndefined()

    expect(probeEvents(events)[0]).toMatchObject({
      chosenRegion: 'no-hint',
      reason: 'catalog-unavailable',
      regions: []
    })
  })

  it('logs the self-heal decision that deletes a cache pinning a far cell', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', 5_000)
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({
        [US]: [400, 300, 300, 300],
        [ASIA]: [90, 30, 30, 30],
        [CELL]: [400, 300, 300, 300]
      })
    })

    await resolver.invalidateIfAssignedCellIsFar(CELL)

    const selfHeal = events.find(
      (event): event is RelayRegionSelfHealLogEvent => event.event === RELAY_REGION_SELF_HEAL_EVENT
    )
    expect(selfHeal).toEqual({
      event: 'relay_region_self_heal',
      directorHost: 'relay.example.test',
      cachedRegion: 'us-central1',
      bestRegion: 'asia-east2',
      bestLatencyMs: 30,
      assignedCellUrl: CELL,
      assignedLatencyMs: 300,
      decision: 'deleted',
      reason: 'assigned-cell-far'
    })
  })

  it('logs a kept cache when the assigned cell is not far from the best region', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', 5_000)
    const { resolver, events } = resolverWithLog({
      path,
      fetch: catalogFetch(BOTH_REGIONS),
      probe: sampledProbe({
        [US]: [400, 300, 300, 300],
        [ASIA]: [90, 200, 200, 200],
        [CELL]: [400, 300, 300, 300]
      })
    })

    await resolver.invalidateIfAssignedCellIsFar(CELL)

    expect(events.at(-1)).toMatchObject({
      event: 'relay_region_self_heal',
      decision: 'kept',
      reason: 'assigned-cell-near',
      assignedLatencyMs: 300
    })
  })

  it('reports a self-heal whose catalog failed as its own outcome, not a withheld hint', async () => {
    const path = userDataPath()
    writeCache(path, 'us-central1', 5_000)
    const { resolver, events } = resolverWithLog({
      path,
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response('nope', { status: 503 }))
    })

    await resolver.invalidateIfAssignedCellIsFar(CELL)

    // A self-heal that never chose a region must not log a probe event that
    // reads as a withheld hint; it names the failure under its own event.
    expect(events.map((event) => event.event)).toEqual([RELAY_REGION_SELF_HEAL_EVENT])
    expect(events[0]).toMatchObject({ decision: 'kept', reason: 'catalog-unavailable' })
  })

  it('emits one credential-free line per event', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRelayRegionEvent({
      event: RELAY_REGION_PROBE_EVENT,
      directorHost: 'relay.example.test',
      regions: [
        {
          region: 'asia-east2',
          origins: [ASIA],
          warmupMs: [90],
          keptMs: [30, 35, 40],
          minMs: 30,
          spreadMs: 10,
          verdict: 'measured'
        }
      ],
      chosenRegion: 'asia-east2',
      reason: 'measured',
      cached: false,
      ttlMs: 1_000
    })

    expect(info).toHaveBeenCalledTimes(1)
    const [tag, line] = info.mock.calls[0] as [string, string]
    expect(tag).toBe('[relay-region]')
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({ event: 'relay_region_probe' })
    expect(line).not.toMatch(/token|jwt|secret|authorization|bearer|relayHostId|eyJ/i)
  })
})
