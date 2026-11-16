import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerProof,
  hostControlProofFixture as fixture,
  openProof,
  ProofSocket
} from '../test-fixtures/host-control-proof.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host control proof cleanup', () => {

  it('does not challenge or register a closed peer after verification finishes', async () => {
    const h = fixture()
    let finish!: (valid: boolean) => void
    h.verify.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const socket = new ProofSocket()
    h.registry.acceptControl(socket.registrySocket(), h.identity)
    socket.emit('message', Buffer.from(h.hello), false)
    expect(h.verify).toHaveBeenCalledOnce()
    socket.peerClose()
    finish(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.send).not.toHaveBeenCalled()
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })
    ).toBeNull()
  })

  it('keeps a newer same-host peer live when the old proof peer closes', async () => {
    const h = fixture()
    const oldPeer = await openProof(h)
    const replacement = await openProof(h)
    oldPeer.peerClose()
    answerProof(replacement, h.keyPair)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      h.registry.get({ userId: h.identity.sub, relayHostId: h.identity.relayHostId })?.socket
    ).toBe(replacement)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(oldPeer.close).not.toHaveBeenCalled()
    expect(replacement.close).not.toHaveBeenCalled()
    h.registry.drain(0)
    await vi.advanceTimersByTimeAsync(0)
  })
})
