import { createElement, type ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

const openHostLogicalClientMock = vi.fn()
const loadHostsMock = vi.fn()
const revival = vi.hoisted(() => ({ callback: null as null | ((reason: 'focus') => void) }))

vi.mock('./host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => openHostLogicalClientMock(...args)
}))
vi.mock('./host-store', () => ({
  loadHosts: () => loadHostsMock()
}))
vi.mock('./connection-revival-triggers', () => ({
  subscribeConnectionRevivalTriggers: (callback: (reason: 'focus') => void) => {
    revival.callback = callback
    return () => {
      revival.callback = null
    }
  }
}))

import {
  useDisconnectHostClient,
  RpcClientProvider,
  useForgetHostClient,
  useForceReconnect,
  useHostClient,
  useRefreshHostClient
} from './client-context'

const HOST = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

type MountedRenderer = {
  unmount(): void
  update(element: ReactElement): void
}

function fakeClient(): RpcClient {
  return {
    sendRequest: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  openHostLogicalClientMock.mockReset()
  loadHostsMock.mockReset()
  revival.callback = null
})

afterEach(() => vi.useRealTimers())

describe('wanted host open recovery', () => {
  it('recovers after a transient catalog failure without remounting', async () => {
    const client = fakeClient()
    loadHostsMock.mockRejectedValueOnce(new Error('catalog unavailable')).mockResolvedValue([HOST])
    openHostLogicalClientMock.mockReturnValue(client)

    let observed: { client: RpcClient | null; state: ConnectionState } | null = null
    let renderer: MountedRenderer | null = null
    function Probe(): null {
      observed = useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      expect(observed).toMatchObject({ client: null, state: 'disconnected' })
      expect(loadHostsMock).toHaveBeenCalledOnce()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(loadHostsMock).toHaveBeenCalledTimes(2)
      expect(openHostLogicalClientMock).toHaveBeenCalledOnce()
      expect(observed).toMatchObject({ client, state: 'connected' })
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('recovers when a missing host appears in the catalog', async () => {
    const client = fakeClient()
    loadHostsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([HOST])
    openHostLogicalClientMock.mockReturnValue(client)

    let observed: { client: RpcClient | null; state: ConnectionState } | null = null
    let renderer: MountedRenderer | null = null
    function Probe(): null {
      observed = useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(loadHostsMock).toHaveBeenCalledTimes(2)
      expect(observed).toMatchObject({ client, state: 'connected' })
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('recovers after synchronous client construction fails', async () => {
    const client = fakeClient()
    loadHostsMock.mockResolvedValue([HOST])
    openHostLogicalClientMock.mockImplementationOnce(() => {
      throw new Error('bad transient profile')
    })
    openHostLogicalClientMock.mockReturnValueOnce(client)

    let observed: { client: RpcClient | null; state: ConnectionState } | null = null
    let renderer: MountedRenderer | null = null
    function Probe(): null {
      observed = useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(openHostLogicalClientMock).toHaveBeenCalledTimes(2)
      expect(observed).toMatchObject({ client, state: 'connected' })
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('expedites recovery without resetting the failure tier', async () => {
    const client = fakeClient()
    loadHostsMock
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce([HOST])
    openHostLogicalClientMock.mockReturnValue(client)

    let renderer: MountedRenderer | null = null
    function Probe(): null {
      useHostClient(HOST.id)
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      act(() => revival.callback?.('focus'))
      await act(async () => {
        await Promise.resolve()
      })
      expect(loadHostsMock).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1_999)
      expect(loadHostsMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(loadHostsMock).toHaveBeenCalledTimes(3)
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('forgets demand while a retry is waiting', async () => {
    loadHostsMock.mockRejectedValue(new Error('catalog unavailable'))

    let forgetHostClient: ((hostId: string) => void) | null = null
    let renderer: MountedRenderer | null = null
    function Probe(): null {
      useHostClient(HOST.id)
      forgetHostClient = useForgetHostClient()
      return null
    }

    try {
      await act(async () => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
        await Promise.resolve()
      })
      act(() => forgetHostClient?.(HOST.id))
      await vi.advanceTimersByTimeAsync(120_000)
      expect(loadHostsMock).toHaveBeenCalledOnce()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('does not let a retired owner cancel a newer acquisition', async () => {
    let resolveReplacement: ((hosts: (typeof HOST)[]) => void) | null = null
    const replacementLookup = new Promise<(typeof HOST)[]>((resolve) => {
      resolveReplacement = resolve
    })
    loadHostsMock.mockResolvedValueOnce([HOST]).mockReturnValueOnce(replacementLookup)
    const firstClient = fakeClient()
    const replacementClient = fakeClient()
    openHostLogicalClientMock
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(replacementClient)

    let disconnectHostClient: ((hostId: string) => void) | null = null
    function RetiredOwner(): null {
      useHostClient(HOST.id)
      disconnectHostClient = useDisconnectHostClient()
      return null
    }
    function NewOwner(): null {
      useHostClient(HOST.id)
      return null
    }
    function App({ oldVisible, newVisible }: { oldVisible: boolean; newVisible: boolean }) {
      return createElement(
        RpcClientProvider,
        null,
        oldVisible ? createElement(RetiredOwner) : null,
        newVisible ? createElement(NewOwner) : null
      )
    }

    let renderer: MountedRenderer | null = null
    try {
      await act(async () => {
        renderer = create(createElement(App, { oldVisible: true, newVisible: false }))
        await Promise.resolve()
      })
      act(() => disconnectHostClient?.(HOST.id))
      act(() => renderer?.update(createElement(App, { oldVisible: true, newVisible: true })))
      act(() => renderer?.update(createElement(App, { oldVisible: false, newVisible: true })))

      await act(async () => {
        resolveReplacement?.([HOST])
        await replacementLookup
      })
      expect(openHostLogicalClientMock).toHaveBeenCalledTimes(2)
      expect(replacementClient.close).not.toHaveBeenCalled()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('keeps explicit reconnect demand through a pre-client failure', async () => {
    loadHostsMock
      .mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce([HOST])
    openHostLogicalClientMock.mockReturnValue(fakeClient())

    let forceReconnect: ((hostId: string) => Promise<void>) | null = null
    function Probe(): null {
      forceReconnect = useForceReconnect()
      return null
    }

    let renderer: MountedRenderer | null = null
    try {
      act(() => {
        renderer = create(createElement(RpcClientProvider, null, createElement(Probe)))
      })
      await act(async () => {
        await forceReconnect?.(HOST.id)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(loadHostsMock).toHaveBeenCalledTimes(2)
      expect(openHostLogicalClientMock).toHaveBeenCalledOnce()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('cancels an in-flight open after the final owner releases', async () => {
    let resolveHosts: ((hosts: (typeof HOST)[]) => void) | null = null
    const lookup = new Promise<(typeof HOST)[]>((resolve) => {
      resolveHosts = resolve
    })
    loadHostsMock.mockReturnValue(lookup)
    openHostLogicalClientMock.mockReturnValue(fakeClient())

    function Probe(): null {
      useHostClient(HOST.id)
      return null
    }
    function App({ visible }: { visible: boolean }) {
      return createElement(RpcClientProvider, null, visible ? createElement(Probe) : null)
    }

    let renderer: MountedRenderer | null = null
    try {
      act(() => {
        renderer = create(createElement(App, { visible: true }))
      })
      expect(loadHostsMock).toHaveBeenCalledOnce()

      act(() => renderer?.update(createElement(App, { visible: false })))
      await act(async () => {
        resolveHosts?.([HOST])
        await lookup
      })

      expect(openHostLogicalClientMock).not.toHaveBeenCalled()
    } finally {
      act(() => renderer?.unmount())
    }
  })

  it('ignores a canceled failure after a replacement client succeeds', async () => {
    let rejectStale: ((error: Error) => void) | null = null
    const staleLookup = new Promise<(typeof HOST)[]>((_, reject) => {
      rejectStale = reject
    })
    loadHostsMock.mockReturnValueOnce(staleLookup).mockResolvedValueOnce([HOST])
    const client = fakeClient()
    openHostLogicalClientMock.mockReturnValue(client)

    let refreshHostClient: ((hostId: string) => void) | null = null
    let replacement: { client: RpcClient | null; state: ConnectionState } | null = null
    function Primary(): null {
      useHostClient(HOST.id)
      refreshHostClient = useRefreshHostClient()
      return null
    }
    function Replacement(): null {
      replacement = useHostClient(HOST.id)
      return null
    }
    function App({ showReplacement }: { showReplacement: boolean }) {
      return createElement(
        RpcClientProvider,
        null,
        createElement(Primary),
        showReplacement ? createElement(Replacement) : null
      )
    }

    let renderer: MountedRenderer | null = null
    try {
      act(() => {
        renderer = create(createElement(App, { showReplacement: false }))
      })
      act(() => refreshHostClient?.(HOST.id))
      await act(async () => {
        renderer?.update(createElement(App, { showReplacement: true }))
        await Promise.resolve()
      })
      expect(replacement).toMatchObject({ client, state: 'connected' })

      await act(async () => {
        rejectStale?.(new Error('stale catalog failure'))
        await Promise.resolve()
      })

      expect(replacement).toMatchObject({ client, state: 'connected' })
    } finally {
      act(() => renderer?.unmount())
    }
  })
})
