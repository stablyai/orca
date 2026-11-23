import { describe, expect, it, vi } from 'vitest'
import type { RpcRequest } from '../core'

const routes = {
  lanEndpoint: 'ws://192.168.50.131:6768/',
  tailnetEndpoint: 'ws://100.120.233.23:6768/'
}

vi.mock('./pairing/network/mobile-tailnet-fallback', () => ({
  discoverAuthenticatedMobileDirectEndpoints: async () => routes
}))

import {
  discoverMobileStatusDirectEndpoints,
  enrichAuthenticatedMobileStatusReply
} from './mobile-status-endpoint-enrichment'

const request: RpcRequest = { id: 'req-1', authToken: 'paired', method: 'status.get' }

describe('paired-device-only mobile route advertisement', () => {
  it('advertises both direct routes only for authenticated, non-probe mobile status reads', async () => {
    const read = (req: RpcRequest, scope: 'runtime' | 'mobile', authenticated: boolean) =>
      discoverMobileStatusDirectEndpoints(req, scope, authenticated, '0.0.0.0', [])

    expect(await read(request, 'mobile', true)).toEqual(routes)
    expect(await read(request, 'mobile', false)).toEqual({})
    expect(await read(request, 'runtime', true)).toEqual({})
    expect(await read({ ...request, params: { probe: true } }, 'mobile', true)).toEqual({})
    expect(await read({ ...request, executionHost: 'other-host' }, 'mobile', true)).toEqual({})
    expect(await read({ ...request, method: 'host.info' }, 'mobile', true)).toEqual({})
  })

  it('adds LAN and Tailnet routes to successful status results without altering errors', () => {
    const success = JSON.stringify({ id: 'req-1', ok: true, result: { appVersion: '1.0' } })
    const parsed = JSON.parse(enrichAuthenticatedMobileStatusReply(success, 'mobile', routes))
    expect(parsed.result).toEqual({
      appVersion: '1.0',
      deviceScope: 'mobile',
      lanEndpoint: 'ws://192.168.50.131:6768/',
      tailnetEndpoint: 'ws://100.120.233.23:6768/'
    })

    const failed = JSON.stringify({ id: 'req-1', ok: false, error: { code: 'error' } })
    expect(enrichAuthenticatedMobileStatusReply(failed, 'mobile', routes)).toBe(failed)
  })
})
