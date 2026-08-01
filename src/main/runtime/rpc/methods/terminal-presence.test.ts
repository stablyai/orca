import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import type { PeerPresenceEvent } from '../../../../shared/peer-presence-event'
import { TERMINAL_PRESENCE_METHODS } from './terminal-presence'

function findMethod(name: string): (typeof TERMINAL_PRESENCE_METHODS)[number] {
  const method = TERMINAL_PRESENCE_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`${name} method missing`)
  }
  return method
}

// Why: a minimal stand-in for OrcaRuntimeService's peer-presence fan-out —
// real enough to exercise sender-exclusion and cleanup dispatch without
// constructing the full runtime.
function makeFakePresenceRuntime(): {
  runtime: RpcContext['runtime']
  cleanups: Map<string, () => void>
} {
  const listeners = new Set<{
    connectionId: string
    terminal: string
    listener: (event: PeerPresenceEvent) => void
  }>()
  const cleanups = new Map<string, () => void>()
  const runtime = {
    onPeerPresence: (
      terminal: string,
      connectionId: string,
      listener: (event: PeerPresenceEvent) => void
    ) => {
      const entry = { terminal, connectionId, listener }
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
    dispatchPeerPresence: (
      terminal: string,
      senderConnectionId: string | undefined,
      event: PeerPresenceEvent
    ) => {
      for (const entry of listeners) {
        if (entry.terminal === terminal && entry.connectionId !== senderConnectionId) {
          entry.listener(event)
        }
      }
    },
    registerSubscriptionCleanup: (
      subscriptionId: string,
      cleanup: () => void,
      _connectionId?: string
    ) => {
      cleanups.set(subscriptionId, cleanup)
    },
    cleanupSubscription: (subscriptionId: string) => {
      cleanups.get(subscriptionId)?.()
      cleanups.delete(subscriptionId)
    }
  } as unknown as RpcContext['runtime']
  return { runtime, cleanups }
}

describe('terminal.presence subscribe/send/unsubscribe', () => {
  it('excludes the sender from its own fan-out', async () => {
    const { runtime } = makeFakePresenceRuntime()
    const subscribe = findMethod('terminal.presence.subscribe')
    const send = findMethod('terminal.presence.send')

    const aEvents: PeerPresenceEvent[] = []
    const emitA = vi.fn(async (event: unknown) => {
      aEvents.push(event as PeerPresenceEvent)
    })
    void subscribe.handler(
      { terminal: 'term-1', clientId: 'client-a' },
      { runtime, connectionId: 'conn-a' } as unknown as RpcContext,
      emitA
    )
    await Promise.resolve()

    const state = {
      participant: { clientId: 'client-a', name: 'A', color: '#111' },
      cursor: null,
      selection: null,
      scroll: { atBottom: true, scrollTop: 0 }
    }
    await send.handler(
      { terminal: 'term-1', state },
      { runtime, connectionId: 'conn-a' } as unknown as RpcContext,
      vi.fn()
    )

    // The sender's own state.send must never echo back into its own subscribe stream.
    expect(aEvents.some((event) => event.type === 'state')).toBe(false)
  })

  it('fans a sent state out to other subscribed connections', async () => {
    const { runtime } = makeFakePresenceRuntime()
    const subscribe = findMethod('terminal.presence.subscribe')
    const send = findMethod('terminal.presence.send')

    const bEvents: PeerPresenceEvent[] = []
    void subscribe.handler(
      { terminal: 'term-1', clientId: 'client-b' },
      { runtime, connectionId: 'conn-b' } as unknown as RpcContext,
      vi.fn(async (event: unknown) => {
        bEvents.push(event as PeerPresenceEvent)
      })
    )
    await Promise.resolve()

    const state = {
      participant: { clientId: 'client-a', name: 'A', color: '#111' },
      cursor: { col: 1, row: 2 },
      selection: null,
      scroll: { atBottom: true, scrollTop: 0 }
    }
    await send.handler(
      { terminal: 'term-1', state },
      { runtime, connectionId: 'conn-a' } as unknown as RpcContext,
      vi.fn()
    )

    expect(bEvents).toContainEqual(
      expect.objectContaining({
        type: 'state',
        state: expect.objectContaining({ participant: state.participant })
      })
    )
  })

  it("reports the subscribing connection's own clientId in the 'left' event on cleanup, not another participant's", async () => {
    const { runtime } = makeFakePresenceRuntime()
    const subscribe = findMethod('terminal.presence.subscribe')
    const send = findMethod('terminal.presence.send')
    const unsubscribe = findMethod('terminal.presence.unsubscribe')

    let subscriptionIdForA: string | undefined
    const aEvents: PeerPresenceEvent[] = []
    void subscribe.handler(
      { terminal: 'term-1', clientId: 'client-a' },
      { runtime, connectionId: 'conn-a' } as unknown as RpcContext,
      vi.fn(async (event: unknown) => {
        const typed = event as PeerPresenceEvent
        aEvents.push(typed)
        if (typed.type === 'ready') {
          subscriptionIdForA = typed.subscriptionId
        }
      })
    )
    await Promise.resolve()

    const bEvents: PeerPresenceEvent[] = []
    void subscribe.handler(
      { terminal: 'term-1', clientId: 'client-b' },
      { runtime, connectionId: 'conn-b' } as unknown as RpcContext,
      vi.fn(async (event: unknown) => {
        bEvents.push(event as PeerPresenceEvent)
      })
    )
    await Promise.resolve()

    // A observes B's state update before disconnecting — this is what used to get
    // captured as "lastClientId" and wrongly broadcast as the one who left.
    const bState = {
      participant: { clientId: 'client-b', name: 'B', color: '#222' },
      cursor: { col: 0, row: 0 },
      selection: null,
      scroll: { atBottom: true, scrollTop: 0 }
    }
    await send.handler(
      { terminal: 'term-1', state: bState },
      { runtime, connectionId: 'conn-b' } as unknown as RpcContext,
      vi.fn()
    )
    expect(aEvents.some((event) => event.type === 'state')).toBe(true)

    if (!subscriptionIdForA) {
      throw new Error('subscriptionIdForA missing')
    }
    await unsubscribe.handler(
      { subscriptionId: subscriptionIdForA },
      { runtime } as unknown as RpcContext,
      vi.fn()
    )

    const leftEvent = bEvents.find((event) => event.type === 'left')
    expect(leftEvent).toMatchObject({ type: 'left', clientId: 'client-a' })
  })

  it('rejects terminal.presence.subscribe from a peer device with no grant for the terminal', async () => {
    const { runtime } = makeFakePresenceRuntime()
    const subscribe = findMethod('terminal.presence.subscribe')

    await expect(
      subscribe.handler(
        { terminal: 'term-1', clientId: 'client-a' },
        {
          runtime,
          connectionId: 'conn-a',
          isPeerDevice: true,
          getGrantedTerminals: () => []
        } as unknown as RpcContext,
        vi.fn()
      )
    ).rejects.toThrow('peer_terminal_not_granted')
  })

  it('rejects terminal.presence.send from a peer device with no grant for the terminal', async () => {
    const { runtime } = makeFakePresenceRuntime()
    const send = findMethod('terminal.presence.send')

    const state = {
      participant: { clientId: 'client-a', name: 'A', color: '#111' },
      cursor: null,
      selection: null,
      scroll: { atBottom: true, scrollTop: 0 }
    }
    await expect(
      send.handler(
        { terminal: 'term-1', state },
        {
          runtime,
          connectionId: 'conn-a',
          isPeerDevice: true,
          getGrantedTerminals: () => []
        } as unknown as RpcContext,
        vi.fn()
      )
    ).rejects.toThrow('peer_terminal_not_granted')
  })

  it('rejects oversized presence fields at the schema boundary', () => {
    // Why: send fans out to every subscriber, so unbounded fields would let one
    // peer amplify oversized payloads to all viewers.
    const send = findMethod('terminal.presence.send')
    const oversized = {
      terminal: 'term-1',
      state: {
        participant: { clientId: 'client-a', name: 'x'.repeat(81), color: '#111' },
        cursor: null,
        selection: null,
        scroll: { atBottom: true, scrollTop: 0 }
      }
    }
    expect(send.params?.safeParse(oversized).success).toBe(false)
  })

  it('scopes peer presence.unsubscribe to subscriptions owned by the calling connection', async () => {
    const unsubscribe = findMethod('terminal.presence.unsubscribe')
    const cleanupSubscription = vi.fn()
    const cleanupSubscriptionOwnedBy = vi.fn(() => false)
    const runtime = {
      cleanupSubscription,
      cleanupSubscriptionOwnedBy
    } as unknown as RpcContext['runtime']

    await unsubscribe.handler(
      { subscriptionId: 'terminal-presence:term-1:conn-other-1' },
      { runtime, connectionId: 'conn-a', isPeerDevice: true } as unknown as RpcContext,
      vi.fn()
    )

    // Why: a peer must never reach the unscoped teardown path with an id it does not own.
    expect(cleanupSubscription).not.toHaveBeenCalled()
    expect(cleanupSubscriptionOwnedBy).toHaveBeenCalledWith(
      'terminal-presence:term-1:conn-other-1',
      'conn-a'
    )
  })
})
