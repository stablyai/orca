import { describe, expect, it, vi } from 'vitest'
import {
  mergeAdvertisedDirectEndpoints,
  refreshHostDirectEndpoints
} from './mobile-direct-endpoint-refresh'
import type { HostProfile, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

const host: HostProfile = {
  id: 'host-1',
  name: 'Desk',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.10:6768' },
    { id: 'stale-cafe', kind: 'lan', url: 'ws://10.0.0.8:6768' },
    {
      id: 'relay-primary',
      kind: 'relay',
      url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
    }
  ],
  relayHostId: relay.relayHostId,
  relay
}

function client(response: RpcResponse): RpcClient {
  return { sendRequest: vi.fn(async () => response) } as unknown as RpcClient
}

describe('mergeAdvertisedDirectEndpoints', () => {
  it('replaces pair-time LAN instead of accumulating cafe and NIC history', () => {
    const next = mergeAdvertisedDirectEndpoints(host, {
      v: 1,
      selected: { kind: 'lan', url: 'ws://192.168.1.50:6768' },
      endpoints: [
        { kind: 'lan', url: 'ws://192.168.1.50:6768' },
        { kind: 'tailscale', url: 'ws://100.64.0.2:6768' }
      ]
    })
    expect(next.endpoint).toBe('ws://192.168.1.50:6768')
    expect(next.endpoints).toEqual([
      { id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.50:6768' },
      { id: 'direct-2', kind: 'tailscale', url: 'ws://100.64.0.2:6768' },
      {
        id: 'relay-primary',
        kind: 'relay',
        url: 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
      }
    ])
  })

  it('keeps pair-time LAN when the desktop advertises nothing', () => {
    expect(
      mergeAdvertisedDirectEndpoints(host, { v: 1, selected: null, endpoints: [] })
    ).toBe(host)
  })

  it('never grows the overlay past 16 entries', () => {
    const endpoints = Array.from({ length: 20 }, (_, index) => ({
      kind: 'lan' as const,
      url: `ws://10.0.0.${index + 1}:6768`
    }))
    const next = mergeAdvertisedDirectEndpoints(host, {
      v: 1,
      selected: endpoints[0]!,
      endpoints
    })
    expect(next.endpoints).toHaveLength(16)
    expect(next.endpoints?.some(({ kind }) => kind === 'relay')).toBe(true)
  })
})

describe('refreshHostDirectEndpoints', () => {
  it('keeps pair-time LAN when an old desktop returns method_not_found', async () => {
    const saveHost = vi.fn()
    const rpc = client({
      id: 'rpc-1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime-1' }
    })
    const unsupported = { current: false }
    await expect(
      refreshHostDirectEndpoints({ client: rpc, host, saveHost, unsupported })
    ).resolves.toBe(host)
    expect(saveHost).not.toHaveBeenCalled()
    expect(unsupported.current).toBe(true)
    await refreshHostDirectEndpoints({ client: rpc, host, saveHost, unsupported })
    expect(rpc.sendRequest).toHaveBeenCalledOnce()
  })

  it('persists the advertised current LAN', async () => {
    const saveHost = vi.fn(async () => {})
    const next = await refreshHostDirectEndpoints({
      client: client({
        id: 'rpc-1',
        ok: true,
        result: {
          v: 1,
          selected: { kind: 'lan', url: 'ws://192.168.1.50:6768' },
          endpoints: [{ kind: 'lan', url: 'ws://192.168.1.50:6768' }]
        },
        _meta: { runtimeId: 'runtime-1' }
      }),
      host,
      saveHost
    })
    expect(next.endpoint).toBe('ws://192.168.1.50:6768')
    expect(saveHost).toHaveBeenCalledWith(next)
  })
})
