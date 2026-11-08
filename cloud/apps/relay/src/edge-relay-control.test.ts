import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  EDGE_CONTROL_APPLIED_EVENT,
  EDGE_CONTROL_DEFAULTS,
  EDGE_CONTROL_OBJECT_NAME,
  parseEdgeControl,
  startEdgeControl,
  type EdgeControlFlags
} from './edge-relay-control.js'
import { edgeCohortBucket, edgeCohortBucketPermille, inEdgeCohort, type EdgeRelayConfig } from './edge-relay-cohort.js'

function edgeConfig(overrides: Partial<EdgeRelayConfig> = {}): EdgeRelayConfig {
  return {
    cellUrl: 'https://edge.relay.example.test',
    rolloutPercent: 0,
    allowHosts: new Set(),
    denyHosts: new Set(),
    regions: new Set(['us-central1']),
    ...overrides
  }
}

function hostId(index: number): string {
  return `host${String(index).padStart(12, '0')}`
}

// Storage answers the stored object (or 404) by generation, like the cell flag channel's tests.
function fakeGoogle() {
  const state: { object: { generation: number; body: string } | null; paths: string[] } = {
    object: null,
    paths: []
  }
  const fetchImpl: typeof fetch = async (target) => {
    const url = new URL(String(target))
    if (url.hostname === 'metadata.google.internal') {
      if (url.pathname.endsWith('/project/project-id')) { return new Response('onorca-cloud') }
      return Response.json({ access_token: 'ya29.secret-access-token', expires_in: 3_600 })
    }
    state.paths.push(decodeURIComponent(url.pathname))
    const object = state.object
    if (!object) { return new Response(null, { status: 404 }) }
    if (url.searchParams.get('ifGenerationNotMatch') === String(object.generation)) {
      return new Response(null, { status: 304 })
    }
    return new Response(object.body, { headers: { 'x-goog-generation': String(object.generation) } })
  }
  const store = (generation: number, flags: Record<string, unknown>) => {
    state.object = { generation, body: JSON.stringify({ v: 1, flags }) }
  }
  return { state, fetchImpl, store }
}

describe('edge runtime control object', () => {
  let log: MockInstance<typeof console.log>
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    log.mockRestore()
    warn.mockRestore()
  })

  it('parses mode and permille, reports unknown keys, and voids the object on any bad known value', () => {
    expect(parseEdgeControl({ v: 1, flags: {} })).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
    expect(parseEdgeControl({ v: 1, flags: { mode: 'down', rolloutPermille: 0, cohort: 'x' } })).toEqual({
      flags: { mode: 'down', rolloutPermille: 0 },
      ignoredKeys: ['cohort']
    })
    expect(parseEdgeControl({ v: 1, flags: { rolloutPermille: 1_000 } })).toEqual({
      flags: { mode: 'on', rolloutPermille: 1_000 },
      ignoredKeys: []
    })
    for (const flags of [
      { mode: 'paused' },
      { mode: true },
      { rolloutPermille: 1_001 },
      { rolloutPermille: -1 },
      { rolloutPermille: 2.5 },
      { rolloutPermille: '5' },
      { mode: 'off', rolloutPermille: null }
    ]) {
      expect(parseEdgeControl({ v: 1, flags })).toBeNull()
    }
    expect(parseEdgeControl({ v: 2, flags: {} })).toBeNull()
    expect(parseEdgeControl({ flags: {} })).toBeNull()
  })

  it('reads director/edge.json, logs each applied change with no ids, and tells listeners', async () => {
    const google = fakeGoogle()
    const control = startEdgeControl({ fetch: google.fetchImpl, autoStart: false })
    const changes: EdgeControlFlags[] = []
    control.onChange(() => changes.push(control.flags()))
    await control.poll()
    expect(control.flags()).toEqual(EDGE_CONTROL_DEFAULTS)
    expect(google.state.paths.at(-1)).toBe(`/storage/v1/b/onorca-cloud-relay-control/o/${EDGE_CONTROL_OBJECT_NAME}`)
    google.store(3, { mode: 'off', rolloutPermille: 25 })
    await control.poll()
    // Unchanged object: no second change.
    await control.poll()
    google.store(4, { mode: 'down', note: 'incident' })
    await control.poll()
    // A bad value voids the object: the last applied flags stay.
    google.store(5, { mode: 'sideways' })
    await control.poll()
    expect(control.flags()).toEqual({ mode: 'down' })
    expect(changes).toEqual([{ mode: 'off', rolloutPermille: 25 }, { mode: 'down' }])
    const applied = log.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((line) => line.event === EDGE_CONTROL_APPLIED_EVENT)
    expect(applied).toEqual([
      { event: EDGE_CONTROL_APPLIED_EVENT, generation: 3, flags: { mode: 'off', rolloutPermille: 25 } },
      { event: EDGE_CONTROL_APPLIED_EVENT, generation: 4, flags: { mode: 'down' }, ignoredKeys: ['note'] }
    ])
    control.stop()
  })

  it('logs a throwing listener and still applies the flags', async () => {
    const google = fakeGoogle()
    const control = startEdgeControl({ fetch: google.fetchImpl, autoStart: false })
    control.onChange(() => {
      throw new Error('listener_broke')
    })
    google.store(2, { mode: 'off' })
    await control.poll()
    expect(control.flags()).toEqual({ mode: 'off' })
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('orca_relay_control_flags_listener_failed')
    control.stop()
  })
})

describe('edge cohort under runtime control', () => {
  it('reads the applied flags on every call: off and down empty the cohort, even allowed hosts', () => {
    const flags: EdgeControlFlags = { mode: 'on' }
    const host = hostId(1)
    const config = edgeConfig({
      rolloutPercent: 100,
      allowHosts: new Set([hostId(2)]),
      allowUsers: new Set(['user-team']),
      control: () => flags
    })
    expect(inEdgeCohort(config, host, 'us-central1')).toBe(true)
    for (const mode of ['off', 'down'] as const) {
      flags.mode = mode
      expect(inEdgeCohort(config, host, 'us-central1')).toBe(false)
      expect(inEdgeCohort(config, hostId(2), 'us-central1')).toBe(false)
      expect(inEdgeCohort(config, host, 'us-central1', 'user-team')).toBe(false)
    }
    flags.mode = 'on'
    expect(inEdgeCohort(config, hostId(2), 'us-central1')).toBe(true)
    // A permille replaces the env percent; deny, allow and region rules still apply around it.
    flags.rolloutPermille = 0
    expect(inEdgeCohort(config, host, 'us-central1')).toBe(false)
    expect(inEdgeCohort(config, hostId(2), 'us-central1')).toBe(true)
    flags.rolloutPermille = 1_000
    expect(inEdgeCohort(config, host, 'us-central1')).toBe(true)
    expect(inEdgeCohort(config, host, 'asia-east2')).toBe(false)
    expect(inEdgeCohort({ ...config, denyHosts: new Set([host]) }, host, 'us-central1')).toBe(false)
  })

  it('keeps every host of P percent in at P × 10 permille, for every P', () => {
    // floor(permille bucket / 10) is the percent bucket, so `bucket < P × 10` iff `bucket < P`.
    const hosts = Array.from({ length: 20_000 }, (_, index) => hostId(index))
    expect(hosts.filter((host) => Math.floor(edgeCohortBucketPermille(host) / 10) !== edgeCohortBucket(host))).toEqual([])
    const sample = hosts.slice(0, 2_000)
    const moved: string[] = []
    for (let percent = 0; percent <= 100; percent += 1) {
      const byPercent = edgeConfig({ rolloutPercent: percent })
      const byPermille = edgeConfig({ rolloutPercent: 0, control: () => ({ mode: 'on', rolloutPermille: percent * 10 }) })
      for (const host of sample) {
        if (inEdgeCohort(byPercent, host, 'us-central1') !== inEdgeCohort(byPermille, host, 'us-central1')) {
          moved.push(`${percent}:${host}`)
        }
      }
    }
    expect(moved).toEqual([])
    // The env percent alone (boot, no permille flag) answers as before.
    expect(sample.filter((host) => inEdgeCohort(edgeConfig({ rolloutPercent: 10 }), host, 'us-central1')))
      .toEqual(sample.filter((host) => edgeCohortBucket(host) < 10))
  })

  it('steps in 1 permille shares, nested, roughly evenly', () => {
    const hosts = Array.from({ length: 20_000 }, (_, index) => hostId(index))
    const share = (permille: number) =>
      hosts.filter((host) => inEdgeCohort(edgeConfig({ control: () => ({ mode: 'on', rolloutPermille: permille }) }), host, 'us-central1'))
    const one = share(1)
    const five = share(5)
    expect(one.length).toBeGreaterThan(5)
    expect(one.length).toBeLessThan(40)
    expect(five.length).toBeGreaterThan(70)
    expect(five.length).toBeLessThan(130)
    // A larger share keeps every host of a smaller one.
    expect(one.every((host) => five.includes(host))).toBe(true)
    const buckets = new Set(hosts.map((host) => edgeCohortBucketPermille(host)))
    expect(buckets.size).toBe(1_000)
  })
})
