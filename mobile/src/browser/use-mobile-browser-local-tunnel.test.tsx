import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileBrowserLocalTunnel,
  type MobileBrowserLocalTunnel
} from './use-mobile-browser-local-tunnel'

vi.mock('../../modules/orca-proxied-browser/src', () => ({
  OrcaProxiedBrowser: {
    isSupported: () => true,
    startProxy: vi.fn(async () => {}),
    stopProxy: vi.fn(async () => {})
  }
}))
vi.mock('./mobile-browser-local-proxy', () => ({
  bridgeProxiedBrowserToTunnel: () => ({ stop: () => {} }),
  proxiedBrowserStoreId: (hostId: string) => `store:${hostId}`
}))

type Reply = (result: unknown) => void

let renderer: ReactTestRenderer
let state: MobileBrowserLocalTunnel
let replies: Reply[]
let client: RpcClient

function Harness(): null {
  state = useMobileBrowserLocalTunnel(client, 'host-a', 'wt-1', true)
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  replies = []
  // SAFETY: the hook reads only browserTunnel and subscribe from the client.
  client = {
    browserTunnel: { onFrame: () => () => {}, send: () => true },
    subscribe: (_method: string, _params: unknown, onData: Reply) => {
      replies.push(onData)
      return () => {}
    }
  } as unknown as RpcClient
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}

async function busy(): Promise<void> {
  await act(async () => {
    replies.at(-1)!({ type: 'error', message: 'binary_handler_mode_conflict' })
    await vi.advanceTimersByTimeAsync(250)
  })
}

describe('a tunnel the host still holds for the previous pane', () => {
  it('asks again until the host frees it', async () => {
    await mount()
    await busy()

    expect(replies).toHaveLength(2)
    expect(state.status).not.toBe('failed')
  })

  it('fails once the host keeps it past the retries', async () => {
    await mount()
    for (let attempt = 0; attempt <= 8; attempt += 1) {
      await busy()
    }

    expect(state).toEqual({ status: 'failed', message: 'binary_handler_mode_conflict' })
  })
})
