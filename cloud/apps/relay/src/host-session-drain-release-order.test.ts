import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAIN_RELEASE_BEFORE_CLOSE_MS } from './host-session-registry.js'
import {
  answerProof,
  hostControlProofFixture,
  openProof,
  ProofSocket
} from './test-fixtures/host-control-proof.js'

// A drained host redials the director the moment it reads `drain` or the close. While this
// cell's release still holds the host's assignment row, that redial is refused row_busy.

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function connectedHost() {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const h = hostControlProofFixture()
  const socket = await openProof(h, new ProofSocket())
  answerProof(socket, h.keyPair)
  await vi.advanceTimersByTimeAsync(0)
  const key = { userId: h.identity.sub, relayHostId: h.identity.relayHostId }
  expect(h.registry.get(key)?.controlActivityId).toBe('control:1')
  socket.send.mockClear()
  return { h, socket, key }
}

function frames(socket: ProofSocket): unknown[] {
  return socket.send.mock.calls.map(([frame]) => JSON.parse(frame) as unknown)
}

function pendingRelease() {
  let settle!: (outcome: 'released' | 'failed') => void
  const promise = new Promise<boolean>((resolve, reject) => {
    settle = (outcome) => (outcome === 'released' ? resolve(true) : reject(new Error('down')))
  })
  return { promise, settle }
}

describe('a zero-grace drain releases the host before telling it', () => {
  it('tells and closes the host only once its control release has landed', async () => {
    const { h, socket, key } = await connectedHost()
    const release = pendingRelease()
    const releaseActivity = vi
      .spyOn(h.assignments, 'releaseActivity')
      .mockReturnValue(release.promise)

    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(releaseActivity).toHaveBeenCalledWith(key, 'control:1')
    // Fenced at once: no longer a session here, and not yet told to leave.
    expect(h.registry.get(key)).toBeNull()
    expect(socket.send).not.toHaveBeenCalled()
    expect(socket.close).not.toHaveBeenCalled()

    release.settle('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(frames(socket)).toEqual([{ type: 'drain', graceMs: 0, recovery: 'resolve-director' }])
    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'resolve configured director'
    )
    expect(socket.send.mock.invocationCallOrder[0]).toBeLessThan(
      socket.close.mock.invocationCallOrder[0]!
    )
  })

  it('closes on the bound when the release has not landed, as before this ordering', async () => {
    const { h, socket } = await connectedHost()
    vi.spyOn(h.assignments, 'releaseActivity').mockReturnValue(pendingRelease().promise)

    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(DRAIN_RELEASE_BEFORE_CLOSE_MS - 1)
    expect(socket.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    expect(frames(socket)).toEqual([{ type: 'drain', graceMs: 0, recovery: 'resolve-director' }])
    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'resolve configured director'
    )
    const slow = vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .filter((line) => line.includes('"orca_relay_host_drain_release_slow"'))
    expect(slow).toHaveLength(1)
    expect(slow[0]).not.toContain(h.identity.relayHostId)
  })

  it("starts the host's splice releases before its control release", async () => {
    // The store runs one host's releases in the order they start, so waiting on the
    // control release covers the splices the drain closed ahead of it.
    const { h, key } = await connectedHost()
    const order: string[] = []
    vi.spyOn(h.assignments, 'releaseActivity').mockImplementation(async (_identity, id) => {
      order.push(id)
      return true
    })
    const session = h.registry.get(key)!
    session.activeSplices.set('conn-a', () => {
      session.activeSplices.delete('conn-a')
      void h.assignments.releaseActivity(key, 'splice:conn-a')
    })

    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(order).toEqual(['splice:conn-a', 'control:1'])
  })

  it('closes at once when the release fails, so a database outage never holds the host', async () => {
    const { h, socket } = await connectedHost()
    const release = pendingRelease()
    vi.spyOn(h.assignments, 'releaseActivity').mockReturnValue(release.promise)

    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(1)
    release.settle('failed')
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'resolve configured director'
    )
  })

  it('does not wait for a host that holds no lease here', async () => {
    // A reserve-mode cell admits hosts from memory, with no activity row to release.
    const { h, socket, key } = await connectedHost()
    h.registry.get(key)!.controlActivityId = null
    const releaseActivity = vi.spyOn(h.assignments, 'releaseActivity')

    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(releaseActivity).not.toHaveBeenCalled()
    expect(frames(socket)).toEqual([{ type: 'drain', graceMs: 0, recovery: 'resolve-director' }])
    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'resolve configured director'
    )
  })

  it('still tells a host with grace at once, and releases it before the closing deadline', async () => {
    const { h, socket } = await connectedHost()
    const release = pendingRelease()
    vi.spyOn(h.assignments, 'releaseActivity').mockReturnValue(release.promise)

    h.registry.drain(10_000)
    expect(frames(socket)).toEqual([
      { type: 'drain', graceMs: 10_000, recovery: 'resolve-director' }
    ])

    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.close).not.toHaveBeenCalled()
    release.settle('released')
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.close).toHaveBeenCalledWith(
      RELAY_CLOSE_CODE.DRAINING,
      'resolve configured director'
    )
    // Told once, by the drain itself; the close adds no second frame.
    expect(frames(socket)).toHaveLength(1)
  })
})
