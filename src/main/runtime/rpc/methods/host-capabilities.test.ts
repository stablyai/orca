import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'

const {
  isPwshAvailable,
  isWslAvailable,
  listWslDistros,
  isGitBashAvailable,
  discoverTailnetPeers
} = vi.hoisted(() => ({
  isPwshAvailable: vi.fn(),
  isWslAvailable: vi.fn(),
  listWslDistros: vi.fn(),
  isGitBashAvailable: vi.fn(),
  discoverTailnetPeers: vi.fn()
}))

vi.mock('../../../pwsh', () => ({ isPwshAvailable }))
vi.mock('../../../wsl', () => ({ isWslAvailable, listWslDistros }))
vi.mock('../../../git-bash', () => ({ isGitBashAvailable }))
vi.mock('../../../network/tailscale-peer-discovery', () => ({ discoverTailnetPeers }))

import { HOST_CAPABILITY_METHODS } from './host-capabilities'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('host capability RPC methods', () => {
  beforeEach(() => {
    isPwshAvailable.mockReset()
    isWslAvailable.mockReset()
    listWslDistros.mockReset()
    isGitBashAvailable.mockReset()
    discoverTailnetPeers.mockReset()
  })

  it('reports Windows shell capability probes through explicit methods', async () => {
    isPwshAvailable.mockReturnValue(true)
    isWslAvailable.mockReturnValue(true)
    listWslDistros.mockReturnValue(['Ubuntu'])
    isGitBashAvailable.mockReturnValue(true)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await expect(dispatcher.dispatch(makeRequest('host.pwsh.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.isAvailable'))).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(dispatcher.dispatch(makeRequest('host.wsl.listDistros'))).resolves.toMatchObject({
      ok: true,
      result: ['Ubuntu']
    })
    await expect(
      dispatcher.dispatch(makeRequest('host.gitBash.isAvailable'))
    ).resolves.toMatchObject({
      ok: true,
      result: true
    })
  })

  it('reports tailnet peer discovery from the host tailscale CLI', async () => {
    const discovery = {
      available: true,
      peers: [
        {
          hostName: 'peer-a',
          dnsName: 'peer-a.tail1234.ts.net',
          ipv4: '100.64.0.2',
          os: 'linux',
          online: true,
          tailscaleSsh: false
        }
      ]
    }
    discoverTailnetPeers.mockResolvedValue(discovery)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HOST_CAPABILITY_METHODS })

    await expect(
      dispatcher.dispatch(makeRequest('host.tailscale.discoverPeers'))
    ).resolves.toMatchObject({
      ok: true,
      result: discovery
    })
  })
})
