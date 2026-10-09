import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  CELL_FLAG_DEFAULTS,
  CELL_FLAGS_APPLIED_EVENT,
  cellFlagObjectName,
  cellFlagParser
} from './cell-flags.js'
import { CONTROL_FLAG_POLL_MS, startControlFlagChannel } from './relay-control-flag-channel.js'

const CELL_ID = 'production-gce-c7'
const ACCESS_TOKEN = 'ya29.secret-access-token'

type StoredObject =
  | { kind: 'object'; generation: number; body: string }
  | { kind: 'status'; status: number }
  | { kind: 'network-error' }

function fakeGoogle(initial: StoredObject = { kind: 'status', status: 404 }) {
  const state = { object: initial, storageRequests: [] as URL[], authorizations: [] as string[] }
  const fetchImpl: typeof fetch = async (target, init) => {
    const url = new URL(String(target))
    if (url.hostname === 'metadata.google.internal') {
      if (url.pathname.endsWith('/project/project-id')) return new Response('onorca-cloud')
      return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3_600 })
    }
    state.storageRequests.push(url)
    state.authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
    const object = state.object
    if (object.kind === 'network-error') throw new TypeError('fetch failed')
    if (object.kind === 'status') return new Response(null, { status: object.status })
    if (url.searchParams.get('ifGenerationNotMatch') === String(object.generation)) {
      return new Response(null, { status: 304 })
    }
    return new Response(object.body, {
      headers: { 'x-goog-generation': String(object.generation) }
    })
  }
  return { state, fetchImpl }
}

function cellObject(generation: number, flags: Record<string, unknown>, cellId = CELL_ID) {
  return {
    kind: 'object' as const,
    generation,
    body: JSON.stringify({ v: 1, cellId, flags })
  }
}

function cellChannel(fetchImpl: typeof fetch, autoStart = false) {
  return startControlFlagChannel({
    objectName: cellFlagObjectName(CELL_ID),
    defaults: CELL_FLAG_DEFAULTS,
    parse: cellFlagParser(CELL_ID),
    appliedEvent: CELL_FLAGS_APPLIED_EVENT,
    fetch: fetchImpl,
    random: () => 0.5,
    autoStart
  })
}

describe('control flag channel', () => {
  let log: MockInstance<typeof console.log>
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    log.mockRestore()
    warn.mockRestore()
    vi.useRealTimers()
  })

  const appliedLines = () =>
    log.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(`"event":"${CELL_FLAGS_APPLIED_EVENT}"`))
      .map((line): unknown => JSON.parse(line))

  it('runs on defaults until a first read, then reads the cell object in the project bucket', async () => {
    const google = fakeGoogle(cellObject(5, { readinessLocal: true }))
    const channel = cellChannel(google.fetchImpl)
    expect(channel.applied()).toEqual({ generation: 0, flags: CELL_FLAG_DEFAULTS })
    await channel.poll()
    expect(google.state.storageRequests[0]?.pathname).toBe(
      `/storage/v1/b/onorca-cloud-relay-control/o/${encodeURIComponent(`cells/${CELL_ID}.json`)}`
    )
    expect(google.state.authorizations[0]).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(channel.applied()).toEqual({
      generation: 5,
      flags: { readinessLocal: true, ticketCheck: 'off' }
    })
  })

  // How a flip is observed: one applied line per generation, and the seat feed's flagsApplied.
  it('flips a flag on and back off, logging each applied generation once', async () => {
    const google = fakeGoogle(cellObject(5, { readinessLocal: true, ticketCheck: 'shadow' }))
    const channel = cellChannel(google.fetchImpl)
    await channel.poll()
    await channel.poll()
    expect(google.state.storageRequests[1]?.searchParams.get('ifGenerationNotMatch')).toBe('5')
    google.state.object = cellObject(7, { readinessLocal: false, ticketCheck: 'off' })
    await channel.poll()
    expect(channel.applied()).toEqual({ generation: 7, flags: CELL_FLAG_DEFAULTS })
    expect(appliedLines()).toEqual([
      {
        event: CELL_FLAGS_APPLIED_EVENT,
        generation: 5,
        flags: { readinessLocal: true, ticketCheck: 'shadow' }
      },
      { event: CELL_FLAGS_APPLIED_EVENT, generation: 7, flags: CELL_FLAG_DEFAULTS }
    ])
  })

  it('keeps the applied values through every kind of lost contact, logging once per cause', async () => {
    const google = fakeGoogle(cellObject(5, { readinessLocal: true }))
    const channel = cellChannel(google.fetchImpl)
    await channel.poll()
    const outages: StoredObject[] = [
      { kind: 'status', status: 503 },
      { kind: 'status', status: 503 },
      { kind: 'status', status: 404 },
      { kind: 'network-error' },
      { kind: 'object', generation: 6, body: '{not json' }
    ]
    for (const outage of outages) {
      google.state.object = outage
      await channel.poll()
      expect(channel.applied().flags.readinessLocal).toBe(true)
    }
    const failures = warn.mock.calls.map((call) => String(call[0]).match(/"failure":"([a-z-]+)"/)?.[1])
    expect(failures).toEqual(['http', 'not-found', 'network', 'malformed'])
    const output = [...log.mock.calls, ...warn.mock.calls].flat().map(String).join('\n')
    expect(output).not.toContain(ACCESS_TOKEN)
  })

  it('ignores a generation below the applied one', async () => {
    const google = fakeGoogle(cellObject(9, { readinessLocal: true }))
    const channel = cellChannel(google.fetchImpl)
    await channel.poll()
    google.state.object = cellObject(8, { readinessLocal: false })
    await channel.poll()
    expect(channel.applied()).toEqual({
      generation: 9,
      flags: { readinessLocal: true, ticketCheck: 'off' }
    })
  })

  it('ignores unknown keys but voids the object on a bad known value or another cell', async () => {
    const google = fakeGoogle(cellObject(5, { readinessLocal: true, admitMode: 'memory' }))
    const channel = cellChannel(google.fetchImpl)
    await channel.poll()
    expect(channel.applied().flags).toEqual({ readinessLocal: true, ticketCheck: 'off' })
    for (const [generation, object] of [
      [6, cellObject(6, { readinessLocal: false, ticketCheck: 'enforce' })],
      [7, cellObject(7, { readinessLocal: 'no' })],
      [8, cellObject(8, { readinessLocal: false }, 'production-gce-c8')]
    ] as const) {
      google.state.object = object
      await channel.poll()
      expect(channel.applied().generation).toBe(5)
      // A voided generation is not re-read until it changes.
      await channel.poll()
      expect(google.state.storageRequests.at(-1)?.searchParams.get('ifGenerationNotMatch')).toBe(
        String(generation)
      )
    }
  })

  it('releases every reply it does not read, and stops reading past 64 KiB', async () => {
    let cancelled = 0
    const streamed = (body: string, status = 200, generation = 5) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(body))
          },
          cancel() {
            cancelled += 1
          }
        }),
        { status, headers: { 'x-goog-generation': String(generation) } }
      )
    let next: () => Response = () => streamed('', 404)
    const google = fakeGoogle()
    const fetchImpl: typeof fetch = async (target, init) =>
      new URL(String(target)).hostname === 'metadata.google.internal'
        ? await google.fetchImpl(target, init)
        : next()
    const channel = cellChannel(fetchImpl)
    for (const status of [404, 503]) {
      next = () => streamed('', status)
      await channel.poll()
    }
    expect(cancelled).toBe(2)
    // An endless body: the pull source never closes, so only the bound ends the read.
    next = () => streamed('x'.repeat(16 * 1024), 200, 5)
    await channel.poll()
    expect(cancelled).toBe(3)
    expect(channel.applied().generation).toBe(0)
    next = () =>
      new Response(JSON.stringify({ v: 1, cellId: CELL_ID, flags: { readinessLocal: true } }), {
        headers: { 'x-goog-generation': '9' }
      })
    await channel.poll()
    expect(channel.applied().generation).toBe(9)
    next = () => streamed('{}', 200, 8)
    await channel.poll()
    expect(cancelled).toBe(4)
  })

  it('reads one at a time and on a jittered 5 s cadence', async () => {
    vi.useFakeTimers()
    const google = fakeGoogle(cellObject(5, { readinessLocal: true }))
    const channel = cellChannel(google.fetchImpl)
    await Promise.all([channel.poll(), channel.poll()])
    expect(google.state.storageRequests).toHaveLength(1)
    const running = cellChannel(google.fetchImpl, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(google.state.storageRequests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(CONTROL_FLAG_POLL_MS)
    expect(google.state.storageRequests).toHaveLength(3)
    running.stop()
    await vi.advanceTimersByTimeAsync(CONTROL_FLAG_POLL_MS * 3)
    expect(google.state.storageRequests).toHaveLength(3)
  })
})
