import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useBrowserScreencastReconnectSignal } from './use-browser-screencast-reconnect-signal'

function createMockClient(initial: ConnectionState): {
  client: RpcClient
  emit: (next: ConnectionState) => void
  listenerCount: () => number
} {
  let state: ConnectionState = initial
  let listener: ((next: ConnectionState) => void) | null = null
  const onStateChange = vi.fn((l: (next: ConnectionState) => void) => {
    listener = l
    return () => {
      listener = null
    }
  })
  const client = { getState: () => state, onStateChange } as unknown as RpcClient
  return {
    client,
    emit: (next) => {
      state = next
      listener?.(next)
    },
    listenerCount: () => (listener ? 1 : 0)
  }
}

describe('useBrowserScreencastReconnectSignal', () => {
  // Why: the mobile browser pane freezes on the last decoded frame after a relay
  // migrateTo / direct-socket reconnect because its render state is never reset.
  // This signal drives that reset, so it must bump on a REconnect only.
  let renderer: ReactTestRenderer | null = null
  let signal = 0

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    signal = 0
  })

  function Harness({ client }: { client: RpcClient | null }): null {
    signal = useBrowserScreencastReconnectSignal(client)
    return null
  }

  it('returns 0 and does not bump on the first connect', () => {
    const { client, emit } = createMockClient('disconnected')
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })
    expect(signal).toBe(0)
    act(() => emit('connected'))
    expect(signal).toBe(0)
  })

  it('records the first connect, then bumps on each later reconnect from disconnected', () => {
    const { client, emit } = createMockClient('disconnected')
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })
    expect(signal).toBe(0)
    act(() => emit('connected')) // first connect: recorded, not yet a reconnect
    expect(signal).toBe(0)
    act(() => emit('disconnected'))
    act(() => emit('connected')) // first reconnect after the initial connect
    expect(signal).toBe(1)
    act(() => emit('disconnected'))
    act(() => emit('connected')) // a second reconnect bumps again
    expect(signal).toBe(2)
  })

  it('bumps once per reconnect (connected -> away -> connected)', () => {
    const { client, emit } = createMockClient('connected')
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })
    expect(signal).toBe(0)
    act(() => emit('disconnected'))
    act(() => emit('connected'))
    expect(signal).toBe(1)
    act(() => emit('reconnecting'))
    act(() => emit('connected'))
    expect(signal).toBe(2)
  })

  it('does not bump on a duplicate connected transition', () => {
    const { client, emit } = createMockClient('connected')
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })
    act(() => emit('connected'))
    expect(signal).toBe(0)
  })

  it('is 0 and subscribes to nothing without a client', () => {
    act(() => {
      renderer = create(createElement(Harness, { client: null }))
    })
    expect(signal).toBe(0)
  })

  it('unsubscribes on unmount', () => {
    const { client, listenerCount } = createMockClient('connected')
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })
    expect(listenerCount()).toBe(1)
    act(() => renderer?.unmount())
    expect(listenerCount()).toBe(0)
    renderer = null
  })
})
