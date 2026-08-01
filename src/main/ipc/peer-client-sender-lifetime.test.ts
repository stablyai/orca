import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { PeerClientSenderLifetime } from './peer-client-sender-lifetime'

function makeSender(): { sender: WebContents; emitDestroyed: () => void } {
  const destroyedListeners = new Set<() => void>()
  const sender = {
    once: (channel: string, listener: () => void) => {
      if (channel === 'destroyed') {
        destroyedListeners.add(listener)
      }
    }
  } as unknown as WebContents
  return {
    sender,
    emitDestroyed: () => {
      for (const listener of destroyedListeners) {
        destroyedListeners.delete(listener)
        listener()
      }
    }
  }
}

function internalSizes(lifetime: PeerClientSenderLifetime): {
  senders: number
  requestIds: number
} {
  const internals = lifetime as unknown as {
    cleanupsBySender: Map<unknown, unknown>
    senderByRequestId: Map<unknown, unknown>
  }
  return {
    senders: internals.cleanupsBySender.size,
    requestIds: internals.senderByRequestId.size
  }
}

describe('PeerClientSenderLifetime', () => {
  it('runs every still-bound cleanup once when the sender is destroyed', () => {
    const lifetime = new PeerClientSenderLifetime()
    const { sender, emitDestroyed } = makeSender()
    const cleanupA = vi.fn()
    const cleanupB = vi.fn()
    lifetime.bind(sender, 'req-a', cleanupA)
    lifetime.bind(sender, 'req-b', cleanupB)

    emitDestroyed()

    expect(cleanupA).toHaveBeenCalledTimes(1)
    expect(cleanupB).toHaveBeenCalledTimes(1)
  })

  it('does not run a cleanup released before the sender is destroyed', () => {
    const lifetime = new PeerClientSenderLifetime()
    const { sender, emitDestroyed } = makeSender()
    const cleanup = vi.fn()
    lifetime.bind(sender, 'req-a', cleanup)

    lifetime.release('req-a')
    emitDestroyed()

    expect(cleanup).not.toHaveBeenCalled()
  })

  it('drops every internal entry on destroy so long-lived processes do not accumulate them', () => {
    const lifetime = new PeerClientSenderLifetime()
    const { sender, emitDestroyed } = makeSender()
    lifetime.bind(sender, 'req-a', vi.fn())
    lifetime.bind(sender, 'req-b', vi.fn())

    emitDestroyed()

    expect(internalSizes(lifetime)).toEqual({ senders: 0, requestIds: 0 })
    // Why: a release arriving after destroy (renderer teardown races) must be a no-op.
    expect(() => lifetime.release('req-a')).not.toThrow()
  })
})
