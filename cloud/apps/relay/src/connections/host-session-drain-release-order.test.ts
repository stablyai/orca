import { RELAY_CLOSE_CODE } from '@orca-cloud/relay-contract/close-codes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerProof,
  hostControlProofFixture,
  openProof,
  ProofSocket
} from '../test-fixtures/host-control-proof.js'

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
})
